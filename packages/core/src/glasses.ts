import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store/types.js";
import type { Approval, ChatMessage } from "./events.js";
import { z } from "zod";
import { defineTool, type ToolDef } from "./tools/index.js";
import { readSealedSetting, writeSealedSetting } from "./secrets.js";

/**
 * Phil's smart glasses (Even G2 through MentraOS; apps/glasses is the miniapp). The glasses app runs on his phone,
 * hears him through the glasses, and talks to HQ with one pairing key made in Settings. HQ keeps only the key's hash,
 * so a database dump or backup can't be used to talk to Jarvis as Phil; pairing again replaces the key, unpairing ends it.
 * What the glasses can do with the key: ask Jarvis something and read the replies. Nothing else in HQ accepts it.
 */
const KEY = "glasses.pairing";
interface Pairing { hash: string; at: string; seenAt?: string }

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

/** Make (or replace) the pairing key. Shown to Phil once; only its hash is kept. */
export async function pairGlasses(store: Pick<Store, "settings">): Promise<string> {
  const key = randomBytes(24).toString("base64url");
  await store.settings.set(KEY, { hash: hashOf(key), at: new Date().toISOString() } satisfies Pairing);
  return key;
}
export async function unpairGlasses(store: Pick<Store, "settings">): Promise<void> { await store.settings.set(KEY, null); }

/** Is this the paired glasses' key? Notes when they were last heard from. */
export async function glassesKeyOk(store: Pick<Store, "settings">, given: string | undefined): Promise<boolean> {
  const p = await store.settings.get<Pairing | null>(KEY, null);
  if (!p || !given) return false;
  const a = Buffer.from(p.hash), b = Buffer.from(hashOf(given));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  // Once a minute is enough for "last seen".
  if (!p.seenAt || Date.now() - Date.parse(p.seenAt) > 60_000) await store.settings.set(KEY, { ...p, seenAt: new Date().toISOString() });
  return true;
}
export async function glassesStatus(store: Pick<Store, "settings">): Promise<{ paired: boolean; pairedAt?: string; seenAt?: string }> {
  const p = await store.settings.get<Pairing | null>(KEY, null);
  return p ? { paired: true, pairedAt: p.at, seenAt: p.seenAt } : { paired: false };
}

/**
 * A reply as the glasses can show it: a small text-only display, so no markdown, tables, links or code fences, and
 * lists as plain lines.
 */
export function glassesText(text: string): string {
  return text
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    // A table: its ruler line goes, and each row becomes one line (spaces and tabs only: \s would swallow the line break).
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(\n|$)/gm, "")
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) => row.split("|").map((c) => c.trim()).filter(Boolean).join(" · "))
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]*[-*•][ \t]+/gm, "- ")
    .replace(/\[(Handed to|Deck ready)[^\]]*\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One reply for the glasses: who said it and the text to show. */
export interface GlassesReply { id: string; who: string; kind?: ChatMessage["kind"]; text: string }
export function glassesReplies(messages: ChatMessage[], to: string, name: (agentId?: string) => string): GlassesReply[] {
  return messages.filter((m) => m.replyTo === to && m.role !== "phil").map((m) => ({ id: m.id, who: m.role === "jarvis" ? "Jarvis" : m.role === "system" ? "HQ" : name(m.agentId), kind: m.kind, text: glassesText(m.text) })).filter((m) => m.text);
}

/** Added to what Jarvis reads when Phil asks through the glasses: the answer has to fit a few lines in his view. */
export const GLASSES_HINT = "\n\n(Phil asked this through his smart glasses, by voice, and reads the answer on a small display in his view while doing something else. Answer in one to three short sentences, plain words, the single most useful thing first; no lists, tables, links or formatting. If there is more, say so in a few words and let him ask. An odd word may be a mishearing.)";

// ---- What Phil switches on for the glasses (Settings › Glasses) -------------------------------------------------

/**
 * Two powers the pairing key does not have until Phil turns them on in Settings (both off by default):
 *   approvals  hear the cards waiting on him and approve or reject them by voice. Money, trades, strategy, shipping
 *              code and updating HQ (alwaysWaits) can be heard and rejected from the glasses but approved only in HQ
 *              or Telegram, where he sees the whole card.
 *   listen     all-day memory: what the glasses hear between questions is kept on HQ for 14 days, so Jarvis can
 *              recall what was said. It records other people too; that's his call where he is.
 */
export interface GlassesOptions { approvals: boolean; listen: boolean }
const OPTS_KEY = "glasses.options";
export async function glassesOptions(store: Pick<Store, "settings">): Promise<GlassesOptions> {
  const o = await store.settings.get<Partial<GlassesOptions> | null>(OPTS_KEY, null);
  return { approvals: o?.approvals === true, listen: o?.listen === true };
}
export async function setGlassesOptions(store: Pick<Store, "settings">, patch: Partial<GlassesOptions>): Promise<GlassesOptions> {
  const next = { ...(await glassesOptions(store)), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === "boolean")) } as GlassesOptions;
  await store.settings.set(OPTS_KEY, next);
  return next;
}

/** A card as the glasses read it out: who asks, what it is, and what happens on approve, in plain words. */
export interface GlassesCard { id: string; print: string; who: string; title: string; text: string; approvable: boolean; why?: string }
export const GLASSES_ONLY_REJECT = "This one moves money, trades, or changes code or HQ: approve it in HQ or Telegram, where you see the whole card. You can reject it from here.";
export function glassesCard(a: Approval, who: string, print: string, approvable: boolean): GlassesCard {
  const body = glassesText(a.body).replace(/\s+/g, " ").slice(0, 600);
  const effect = a.effect ? glassesText(a.effect).replace(/\s+/g, " ").slice(0, 300) : "";
  return { id: a.id, print, who, title: glassesText(a.title).slice(0, 160), text: `${body}${effect ? `\nIf you approve: ${effect}` : ""}`, approvable, ...(approvable ? {} : { why: GLASSES_ONLY_REJECT }) };
}

// ---- All-day memory ----------------------------------------------------------------------------------------------

/** One stretch of speech the glasses heard, with when it ended. */
export interface Heard { at: string; text: string }
const HEARD_PREFIX = "glasses.heard.";
const KEEP_DAYS = 14, DAY_CAP = 400_000;
/** The day a moment falls on where Phil is (Eastern unless PHIL_TZ says otherwise). */
const dayOf = (at: number, tz = process.env.PHIL_TZ || "America/New_York") => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/**
 * Keep what the glasses heard, sealed at rest (it is other people's words as much as Phil's). Grouped by day; a day
 * holds up to about 400 KB of text (some twelve hours of steady talk), and days older than two weeks are dropped.
 */
export async function saveHeard(store: Pick<Store, "settings">, segments: Heard[], now = Date.now()): Promise<{ kept: number }> {
  const clean = segments
    .map((s) => ({ at: Number.isFinite(Date.parse(s.at)) ? new Date(Math.min(Date.parse(s.at), now)).toISOString() : new Date(now).toISOString(), text: String(s.text ?? "").replace(/\s+/g, " ").trim().slice(0, 2000) }))
    .filter((s) => s.text.length > 1 && now - Date.parse(s.at) < KEEP_DAYS * 86_400_000);
  const byDay = new Map<string, Heard[]>();
  for (const s of clean) { const d = dayOf(Date.parse(s.at)); byDay.set(d, [...(byDay.get(d) ?? []), s]); }
  let kept = 0;
  for (const [day, add] of byDay) {
    const was = (await readSealedSetting<Heard[]>(store, HEARD_PREFIX + day)).value ?? [];
    let size = was.reduce((n, s) => n + s.text.length, 0);
    const room: Heard[] = [];
    for (const s of add) { if (size + s.text.length > DAY_CAP) break; size += s.text.length; room.push(s); }
    if (!room.length) continue;
    await writeSealedSetting(store, HEARD_PREFIX + day, [...was, ...room].sort((a, b) => a.at.localeCompare(b.at)));
    kept += room.length;
  }
  // Two weeks and no more.
  const index = await store.settings.get<string[]>(HEARD_PREFIX + "days", []);
  const days = [...new Set([...index, ...byDay.keys()])].sort();
  const cutoff = dayOf(now - KEEP_DAYS * 86_400_000);
  for (const d of days.filter((d) => d < cutoff)) await store.settings.set(HEARD_PREFIX + d, null);
  await store.settings.set(HEARD_PREFIX + "days", days.filter((d) => d >= cutoff));
  return { kept };
}
/** Forget everything the glasses heard (Settings, when Phil turns the memory off and asks). */
export async function forgetHeard(store: Pick<Store, "settings">): Promise<number> {
  const days = await store.settings.get<string[]>(HEARD_PREFIX + "days", []);
  for (const d of days) await store.settings.set(HEARD_PREFIX + d, null);
  await store.settings.set(HEARD_PREFIX + "days", []);
  return days.length;
}
export async function heardDays(store: Pick<Store, "settings">): Promise<string[]> { return store.settings.get<string[]>(HEARD_PREFIX + "days", []); }

/** What was heard, for an agent: one day (default today), or every kept day when searching; newest last; a time on each line. */
export async function heardText(store: Pick<Store, "settings">, opts: { day?: string; query?: string; max?: number; now?: number } = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const days = await heardDays(store);
  if (!days.length) return (await glassesOptions(store)).listen ? "Nothing heard yet: the glasses' all-day memory is on, but they haven't sent anything." : "The glasses' all-day memory is off (Phil turns it on in HQ › Settings › Glasses). Nothing is kept.";
  const q = opts.query?.trim().toLowerCase();
  const words = q ? q.split(/\s+/).filter((w) => w.length > 2) : [];
  const want = q ? days : [opts.day ?? dayOf(now)];
  const time = (at: string) => new Intl.DateTimeFormat("en-US", { timeZone: process.env.PHIL_TZ || "America/New_York", hour: "numeric", minute: "2-digit" }).format(Date.parse(at));
  const lines: string[] = [];
  for (const d of want) {
    const list = (await readSealedSetting<Heard[]>(store, HEARD_PREFIX + d)).value ?? [];
    for (const s of list) if (!words.length || words.some((w) => s.text.toLowerCase().includes(w))) lines.push(`${q ? `${d} ` : ""}${time(s.at)}  ${s.text}`);
  }
  const max = opts.max ?? 120;
  if (!lines.length) return q ? `Nothing heard in the last ${days.length} day(s) mentions "${opts.query}".` : `Nothing heard on ${want[0]}. Days kept: ${days.join(", ")}.`;
  const shown = lines.slice(-max);
  return `${q ? `What the glasses heard mentioning "${opts.query}"` : `What the glasses heard on ${want[0]}`} (a transcript of everyone in earshot, not only Phil; it can mishear):\n${lines.length > shown.length ? `(${lines.length - shown.length} earlier lines not shown)\n` : ""}${shown.join("\n")}`;
}

export const GLASSES_TOOLS: ToolDef[] = [
  defineTool({
    name: "glasses_heard",
    description: "What Phil's glasses heard through the day (his all-day memory, when he has it on): a timed transcript of what was said around him, everyone in earshot, kept 14 days. With `query`, every line in those days that mentions it; else one day (default today). Use it when he asks what someone said, what was agreed, or what he was told.",
    schema: {
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; default today"),
      query: z.string().max(120).optional().describe("words to look for across every kept day"),
    },
    async handler({ day, query }, { store }) { return heardText(store, { day, query }); },
  }),
];
