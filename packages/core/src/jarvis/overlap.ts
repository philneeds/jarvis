import type { Approval } from "../events.js";
import { alwaysWaits } from "./rules.js";

/**
 * Does a new approval card cover the same thing as an older pending one? Used so an agent's revised card replaces its
 * earlier one instead of both waiting in Needs you (Nov 13: Monica re-planned the ProEdge week four times, Phil approved
 * all 13 cards, and the calendar got 13 events for 4 slots).
 *
 * Narrow on purpose; a wrong replacement throws away a card Phil should have seen:
 *  - same agent, same action, a different run (cards from one run are one plan and never replace each other);
 *  - a specific target in common: the same event id, the same calendar account and overlapping time, the same email
 *    recipients and subject, the same customer conversation, the same record. A matching title alone never counts;
 *  - never a money, strategy, code or update card, either side: those always come to Phil one by one;
 *  - never a card Phil has edited or asked about.
 */
type Card = Pick<Approval, "agentId" | "title" | "payload" | "runId" | "kind"> & Partial<Pick<Approval, "status" | "original" | "editedBy" | "thread">>;

export function supersedes(next: Card, old: Card): boolean {
  if (old.status !== "pending" || old.agentId !== next.agentId) return false;
  if (!next.runId || !old.runId || next.runId === old.runId) return false;
  if (alwaysWaits(next) || alwaysWaits(old)) return false;
  if (old.original !== undefined || old.editedBy || (old.thread?.length ?? 0) > 0) return false;
  const a = (next.payload ?? {}) as Record<string, unknown>, b = (old.payload ?? {}) as Record<string, unknown>;
  const action = typeof a.action === "string" ? a.action : undefined;
  if (!action || action !== b.action) return false;
  if (lower(a.account) !== lower(b.account)) return false;
  switch (action) {
    case "calendar.create": return slotsOverlap(slot(a), slot(b));
    case "calendar.update": case "calendar.delete": return !!a.id && a.id === b.id;
    case "gmail.send": return !!recipients(a.to) && recipients(a.to) === recipients(b.to) && subject(a.subject) === subject(b.subject);
    case "ghl.message": return !!a.contactId && a.contactId === b.contactId;
    case "memory.replace": return true; // each condense proposal is the whole memory: the newest one is the one to judge
    default:
      // A record or memory write: the same record id or key.
      for (const k of ["id", "recordId", "key"] as const) if (typeof a[k] === "string" && a[k] && a[k] === b[k]) return lower(a.scope) === lower(b.scope);
      return false;
  }
}

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const norm = (v: unknown) => lower(v).replace(/[^a-z0-9]+/g, " ").trim();
const subject = (v: unknown) => norm(v).replace(/^((re|fwd?|fw)\s+)+/, "");
const recipients = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(/[,;]/)).map(lower).filter(Boolean).sort().join(",");

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const TZ = () => process.env.PHIL_TZ || "America/New_York";

/**
 * When an event happens, in one clock: UTC minutes. A time with Z or an offset is exact; a bare time is Phil's wall
 * clock (PHIL_TZ). allDay events only ever match all-day events on the same date.
 */
interface Slot { date: string; start: number; end: number; allDay: boolean; days: Set<string>; repeats: "no" | "weekly" | "other" }

/** Minutes since the epoch for a wall-clock time in a time zone. */
function wallToUtcMin(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asTz = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((guess - (asTz - guess)) / 60_000);
}
function toMin(s: string): { min: number; date: string; allDay: boolean } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { min: Date.UTC(y, mo - 1, d) / 60_000, date, allDay: true };
  if (m[6]) return { min: Math.round(Date.parse(s.trim()) / 60_000), date, allDay: false };
  return { min: wallToUtcMin(y, mo, d, Number(m[4]), Number(m[5]), TZ()), date, allDay: false };
}

export function slot(p: Record<string, unknown>): Slot | null {
  const s = toMin(String(p.start ?? "")), e = toMin(String(p.end ?? ""));
  if (!s) return null;
  const end = e && e.min > s.min ? e.min : s.min + (s.allDay ? 24 * 60 : 60);
  const rule = (Array.isArray(p.recurrence) ? p.recurrence.join(";") : String(p.recurrence ?? "")).toUpperCase();
  const own = DAYS[new Date(Date.UTC(Number(s.date.slice(0, 4)), Number(s.date.slice(5, 7)) - 1, Number(s.date.slice(8, 10)))).getUTCDay()] ?? "";
  let repeats: Slot["repeats"] = "no";
  let days = new Set<string>([own]);
  if (/FREQ=/.test(rule)) {
    // Only plain daily or weekly rules are compared by weekday; anything with an interval, an end, or another frequency
    // is compared by its first occurrence only, so it can't wrongly swallow an unrelated card.
    if (/FREQ=(DAILY|WEEKLY)/.test(rule) && !/INTERVAL=([2-9]|\d{2,})|UNTIL=|COUNT=/.test(rule)) {
      repeats = "weekly";
      const by = (/BYDAY=([A-Z0-9,+-]+)/.exec(rule)?.[1] ?? "").split(",").filter(Boolean).map((x) => x.replace(/^[+-]?\d+/, ""));
      days = new Set(/FREQ=DAILY/.test(rule) && !by.length ? DAYS : by.length ? by : [own]);
    } else repeats = "other";
  }
  return { date: s.date, start: s.min, end, allDay: s.allDay, days, repeats };
}

export function slotsOverlap(a: Slot | null, b: Slot | null): boolean {
  if (!a || !b) return false;
  if (a.allDay !== b.allDay) return false; // a birthday isn't a clash with a dentist appointment
  if (a.allDay) return a.date === b.date && a.repeats === "no" && b.repeats === "no";
  if (a.repeats !== "weekly" && b.repeats !== "weekly") return a.start < b.end && b.start < a.end; // one-offs (and odd rules, first occurrence): real overlap
  // A weekly/daily series against something: same time of day (in UTC minutes) and a shared weekday, from its first date on.
  const tod = (x: Slot) => [((x.start % 1440) + 1440) % 1440, ((x.start % 1440) + 1440) % 1440 + (x.end - x.start)] as const;
  const [as, ae] = tod(a), [bs, be] = tod(b);
  if (!(as < be && bs < ae)) return false;
  if (![...a.days].some((x) => b.days.has(x))) return false;
  if (a.repeats === "weekly" && b.repeats === "weekly") return true;
  const [once, rep] = a.repeats === "weekly" ? [b, a] : [a, b];
  return once.start >= rep.start;
}
