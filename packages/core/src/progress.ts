import type { Approval, AttentionItem, Goal, Horizon, PlayerLevel, Today, TodayItem, Trophy, VentureLevel } from "./events.js";
import { getAgent } from "./registry/index.js";

/**
 * Progress Phil can see on the base: goal horizons, trophies, venture levels, today's three and the streak.
 *
 * Everything here is worked out from things that really happened (a benchmark ticked, a goal finished, an approval
 * decided). Nothing is awarded for activity alone, and none of it is shown to agents: a level they could see would be a
 * reason to invent work.
 */

/** Today's date on Phil's clock, YYYY-MM-DD. */
export const philDay = (at: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: process.env.PHIL_TZ || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

export const HORIZONS: Horizon[] = ["long", "mid", "short"];
export const HORIZON_LABEL: Record<Horizon, string> = { long: "Long term", mid: "Mid term", short: "Short term" };

/** A goal's horizon: what Phil set, else read off its deadline (two weeks or less is short, four months or less is mid). */
export function horizonOf(g: Pick<Goal, "horizon" | "deadline">, now: Date = new Date()): Horizon {
  if (g.horizon) return g.horizon;
  if (!g.deadline) return "long";
  const days = (Date.parse(`${g.deadline}T12:00:00Z`) - now.getTime()) / 86_400_000;
  return days <= 14 ? "short" : days <= 120 ? "mid" : "long";
}

/**
 * Trophies needed to reach levels 1 to 5. Every trophy counts once: a benchmark met is one, and finishing the goal is
 * one more. (Weighting a finished goal higher would let a goal with a single benchmark jump two levels.)
 */
export const LEVEL_AT = [0, 1, 3, 6, 10];
export const trophyPoints = (_t: Pick<Trophy, "kind">) => 1;
export function levelFor(hits: number): VentureLevel {
  let level = 1;
  for (let i = 0; i < LEVEL_AT.length; i++) if (hits >= LEVEL_AT[i]!) level = i + 1;
  return { level, hits, next: LEVEL_AT[level] };
}
/** Each venture's level, from the trophies earned on goals tied to it. A venture with none is level 1 and isn't listed. */
export function ventureLevels(trophies: Trophy[]): Record<string, VentureLevel> {
  const hits: Record<string, number> = {};
  for (const t of trophies) if (t.venture) hits[t.venture] = (hits[t.venture] ?? 0) + trophyPoints(t);
  return Object.fromEntries(Object.entries(hits).map(([v, n]) => [v, levelFor(n)]));
}

/**
 * Bring the trophy list in line with one goal after it changed: a trophy for each benchmark met and one for the goal
 * itself at 100%. Unticking a benchmark takes its trophy back; a benchmark that was met and later dropped from the list
 * keeps its trophy, because it did happen.
 */
export function syncTrophies(trophies: Trophy[], goal: Goal, now: string = new Date().toISOString()): { trophies: Trophy[]; changed: boolean } {
  let list = trophies, changed = false;
  const has = (id: string) => list.some((t) => t.id === id);
  const add = (t: Trophy) => { list = [...list, t]; changed = true; };
  const drop = (id: string) => { list = list.filter((t) => t.id !== id); changed = true; };
  for (const b of goal.benchmarks ?? []) {
    const id = `b:${goal.id}:${b.id}`;
    if (b.done && !has(id)) add({ id, at: b.doneAt ?? now, title: b.text, goalId: goal.id, goalName: goal.name, venture: goal.venture, kind: "benchmark" });
    else if (!b.done && has(id)) drop(id);
  }
  // A trophy follows its goal: give the goal a venture later (or move it) and the level moves with it.
  if (list.some((t) => t.goalId === goal.id && (t.venture !== goal.venture || t.goalName !== goal.name))) { list = list.map((t) => (t.goalId === goal.id ? { ...t, venture: goal.venture, goalName: goal.name } : t)); changed = true; }
  const gid = `g:${goal.id}`;
  if (goal.pct >= 100 && !has(gid)) add({ id: gid, at: now, title: goal.name, goalId: goal.id, goalName: goal.name, venture: goal.venture, kind: "goal" });
  else if (goal.pct < 100 && has(gid)) drop(gid);
  return { trophies: changed ? list.slice(-500) : trophies, changed };
}

/** `decided`: ids of cards Phil decided himself. Without it, a card that is no longer pending counts as decided. */
export interface TodayContext { pending: Approval[]; decided?: Set<string>; attention: AttentionItem[]; goals: Goal[] }
const clip = (s: string, n = 120) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const ventureOfAgent = (agentId: string) => { const v = getAgent(agentId)?.venture; return !v || v === "root" ? "command" : v; };

/**
 * Three things for today when David hasn't picked: up to two of the oldest things waiting on Phil (they block an
 * agent), then the next unmet benchmark of each goal, primary first and nearest deadline next.
 */
export function pickToday(date: string, ctx: TodayContext, now: string = new Date().toISOString()): Today {
  const waiting: Omit<TodayItem, "id" | "done">[] = [
    ...[...ctx.pending].sort((a, b) => (a.at < b.at ? -1 : 1)).map((a) => ({ text: clip(`Decide: ${a.title}`), venture: ventureOfAgent(a.agentId), ref: { kind: "approval" as const, id: a.id } })),
    ...ctx.attention.filter((x) => x.status === "open").sort((a, b) => (a.at < b.at ? -1 : 1)).map((x) => ({ text: clip(x.title), venture: x.venture && x.venture !== "root" ? x.venture : ventureOfAgent(x.agentId), ref: { kind: "attention" as const, id: x.id } })),
  ];
  const ordered = [...ctx.goals].filter((g) => g.pct < 100).sort((a, b) => (a.primary === b.primary ? (a.deadline ?? "9999") < (b.deadline ?? "9999") ? -1 : 1 : a.primary ? -1 : 1));
  // A goal with no benchmarks of its own but shorter goals feeding it moves through them, so it gets no line.
  const fed = new Set(ctx.goals.map((g) => g.parent).filter(Boolean));
  const steps: Omit<TodayItem, "id" | "done">[] = ordered.filter((g) => g.benchmarks?.some((x) => !x.done) || !fed.has(g.id)).map((g) => {
    const b = g.benchmarks?.find((x) => !x.done);
    return b ? { text: clip(b.text), goalId: g.id, venture: g.venture, ref: { kind: "benchmark" as const, id: b.id, goalId: g.id } } : { text: clip(`Move "${g.name}" forward`), goalId: g.id, venture: g.venture };
  });
  const first = waiting.slice(0, 2), fromGoals = steps.slice(0, 3 - first.length);
  const picked = [...first, ...fromGoals, ...waiting.slice(2)].slice(0, 3);
  return { date, by: "auto", pickedAt: now, items: picked.map((p, i) => ({ id: `${date}:${i}`, done: false, ...p })) };
}

/** Tick whatever got done elsewhere: the approval was decided, the to-do was ticked, the benchmark was met. */
export function reconcileToday(today: Today, ctx: TodayContext, now: string = new Date().toISOString()): { today: Today; changed: boolean } {
  let changed = false;
  const pending = new Set(ctx.pending.map((a) => a.id));
  const items = today.items.map((it) => {
    if (it.done || !it.ref) return it;
    // "Decide: …" is done when Phil decided it, not when the card went away: one that was replaced or withdrawn
    // would otherwise hand him a finished day (and its XP) for a decision he never made.
    const done = it.ref.kind === "approval" ? (ctx.decided ? ctx.decided.has(it.ref.id) : !pending.has(it.ref.id))
      : it.ref.kind === "attention" ? (ctx.attention.find((x) => x.id === it.ref!.id)?.status ?? "done") === "done"
      : !!ctx.goals.find((g) => g.id === it.ref!.goalId)?.benchmarks?.find((b) => b.id === it.ref!.id)?.done;
    if (!done) return it;
    changed = true;
    return { ...it, done: true, doneAt: now };
  });
  return { today: changed ? { ...today, items } : today, changed };
}

/**
 * Phil's own level. XP comes only from things that got done: a trophy (a benchmark met or a goal finished) 10, a day
 * with all of today's three done 15, a to-do ticked off 5, a card he decided himself 2. Nothing for time spent or for
 * agents' activity. Each level takes 25 more XP than the last: 50 to reach level 2, 75 more for 3, and so on.
 */
export const XP = { trophy: 10, fullDay: 15, todo: 5, decision: 2 } as const;
export function playerLevel(from: PlayerLevel["from"]): PlayerLevel {
  const total = from.trophies * XP.trophy + from.fullDays * XP.fullDay + from.todosDone * XP.todo + from.decisions * XP.decision;
  let level = 1, left = total, need = 50;
  while (left >= need) { left -= need; level++; need += 25; }
  return { level, total, xp: left, next: need, from };
}

/** `full` latches once the day's list was finished, so replacing the list afterwards doesn't take the day back. */
export type TodayLog = Record<string, { done: number; total: number; full?: boolean }>;
/** Days in a row with all of the day's three done. Today counts once it's complete; an unfinished today doesn't break the run. */
export function streakOf(log: TodayLog, date: string): number {
  const full = (d: string) => { const e = log[d]; return !!e && (!!e.full || (e.total > 0 && e.done >= e.total)); };
  const prev = (d: string) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
  let n = 0, d = full(date) ? date : prev(date);
  while (full(d)) { n++; d = prev(d); }
  return n;
}
