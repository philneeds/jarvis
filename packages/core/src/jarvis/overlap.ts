import type { Approval } from "../events.js";

/**
 * Does a new approval card cover the same thing as an older pending one? Used so an agent's revised card replaces its
 * earlier one instead of both waiting in Needs you (Nov 13: Monica re-planned the ProEdge week four times, Phil approved
 * all 13 cards, and the calendar got 13 events for 4 slots).
 *
 * Only cards from the same agent with the same action count, and only from an earlier run: cards queued in one run are
 * one plan and never replace each other.
 */
export function supersedes(next: Pick<Approval, "agentId" | "title" | "payload" | "runId">, old: Pick<Approval, "agentId" | "title" | "payload" | "runId" | "status">): boolean {
  if (old.status !== "pending" || old.agentId !== next.agentId) return false;
  if (!next.runId || !old.runId || next.runId === old.runId) return false;
  const a = (next.payload ?? {}) as Record<string, unknown>, b = (old.payload ?? {}) as Record<string, unknown>;
  const action = typeof a.action === "string" ? a.action : undefined;
  if (!action || action !== b.action) return false;
  if (lower(a.account) !== lower(b.account)) return false;
  if (action === "calendar.create") return norm(a.title) === norm(b.title) || slotsOverlap(slot(a), slot(b));
  if (action === "calendar.update" || action === "calendar.delete") return !!a.id && a.id === b.id;
  if (action === "gmail.send") return recipients(a.to) === recipients(b.to) && subject(a.subject) === subject(b.subject);
  return norm(next.title) === norm(old.title);
}

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const norm = (v: unknown) => lower(v).replace(/[^a-z0-9]+/g, " ").trim();
const subject = (v: unknown) => norm(v).replace(/^((re|fwd?|fw)\s+)+/, "");
const recipients = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(/[,;]/)).map(lower).filter(Boolean).sort().join(",");

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface Slot { date: string; from: number; to: number; days: Set<string>; repeats: boolean }

/** When an event happens: its first date, minutes into the day (wall clock as written), and which weekdays. */
export function slot(p: Record<string, unknown>): Slot | null {
  const s = String(p.start ?? ""), e = String(p.end ?? "");
  const d = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
  if (!d) return null;
  const t = /T(\d{2}):(\d{2})/.exec(e);
  const from = d[4] ? Number(d[4]) * 60 + Number(d[5]) : 0;
  let to = t ? Number(t[1]) * 60 + Number(t[2]) : 24 * 60;
  if (to <= from) to = 24 * 60; // runs past midnight or all-day
  const rule = (Array.isArray(p.recurrence) ? p.recurrence.join(";") : String(p.recurrence ?? "")).toUpperCase();
  const repeats = /FREQ=/.test(rule);
  const own = DAYS[new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))).getUTCDay()] ?? "";
  const by = (/BYDAY=([A-Z0-9,+-]+)/.exec(rule)?.[1] ?? "").split(",").filter(Boolean).map((x) => x.replace(/^[+-]?\d+/, ""));
  const days = new Set<string>(repeats ? (/FREQ=DAILY/.test(rule) && !by.length ? DAYS : by.length ? by : [own]) : [own]);
  return { date: `${d[1]}-${d[2]}-${d[3]}`, from, to, days, repeats };
}

export function slotsOverlap(a: Slot | null, b: Slot | null): boolean {
  if (!a || !b) return false;
  if (a.from >= b.to || b.from >= a.to) return false;
  if (![...a.days].some((x) => b.days.has(x))) return false;
  if (!a.repeats && !b.repeats) return a.date === b.date;
  if (a.repeats && b.repeats) return true;
  const [once, rep] = a.repeats ? [b, a] : [a, b];
  return once.date >= rep.date;
}
