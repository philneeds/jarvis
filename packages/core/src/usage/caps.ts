import type { PlanUsage, UsageSummary } from "../events.js";
import type { AgentDef } from "../registry/agents.js";
import { AGENT_BY_ID } from "../registry/index.js";
import type { Store, UsageRecord } from "../store/types.js";
import { MODELS } from "../models.js";

/**
 * Usage rationing. Work is rationed by priority against each pool so a busy month degrades gracefully instead of
 * stopping or overspending:
 *   Claude, signed in with Phil's plan (the default): there is no dollar pool. The plan has rolling five-hour and
 *                        weekly windows, and the only signal HQ gets is a run refused with "limit reached, resets at
 *                        4:40pm". HQ records that reset time (noteClaudeLimit) and holds room and pause-first work
 *                        until then; Phil's own asks and the always-tier still run. Spend is shown at list price for
 *                        information only.
 *   CLAUDE_MONTHLY_USD   only with an API key from a linked Console account (CLAUDE_MODE=api), where the plan's
 *                        monthly API credit applies (Max 5x $100, Max 20x $200): the pool is list-price cost against it.
 *                        0 (default) means no dollar pool.
 *   XAI_MONTHLY_USD      what HQ may spend at xAI per month: X searches, and Grok runs when GROK_MODE=api (default 30).
 *   GROK_WEEKLY_RUNS     when GROK_MODE=cli, the Grok Build CLI runs HQ may use per week on SuperGrok (default 400).
 * Priority rules:
 *   always      Jarvis, Stella's team, anything Phil asks for directly: never throttled
 *   room        briefs, holdings reviews, research: hold when a pool passes 90%
 *   pause-first scheduled scanners: back off when a pool passes 70%
 */
export const CAPS = {
  get claudeMonthlyUsd() { return Number(process.env.CLAUDE_MONTHLY_USD ?? 0); },
  get xaiMonthlyUsd() { return Number(process.env.XAI_MONTHLY_USD ?? 30); },
  get grokWeeklyRuns() { return Number(process.env.GROK_WEEKLY_RUNS ?? 400); },
  get pauseFirstAt() { return Number(process.env.THROTTLE_PAUSE_FIRST_AT ?? 0.7); },
  get roomAt() { return Number(process.env.THROTTLE_ROOM_AT ?? 0.9); },
};

/** The plan said no: when it resets, and what it said. Cleared by time, not by hand. */
export const CLAUDE_LIMIT_KEY = "claude.limit";
export interface ClaudeLimit { until: string; message: string; at: string }

/**
 * The reset time in a limit message ("resets 4:40pm", "resets at 16:40", "try again in 2 hours", an ISO time), as the
 * next such moment after now in the server's clock; an hour from now when the message gives none.
 */
export function parseResetTime(message: string, now = new Date()): Date {
  const iso = message.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/);
  if (iso) { const d = new Date(iso[1]!); if (!Number.isNaN(d.getTime()) && d > now) return d; }
  const rel = message.match(/\b(?:in|after)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|h|m)\b/i);
  if (rel) return new Date(now.getTime() + Number(rel[1]) * (/^h/i.test(rel[2]!) ? 3_600_000 : 60_000));
  const clock = message.match(/\b(?:resets?|reset at|try again at|available at|until)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (clock) {
    let h = Number(clock[1]); const m = Number(clock[2] ?? 0); const ap = clock[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  return new Date(now.getTime() + 60 * 60_000);
}

/** A Claude run was refused for usage: remember until when, so routines wait instead of failing one after another. */
export async function noteClaudeLimit(store: Store, message: string, now = new Date()): Promise<ClaudeLimit> {
  const until = parseResetTime(message, now);
  const lim: ClaudeLimit = { until: until.toISOString(), message: message.slice(0, 200), at: now.toISOString() };
  await store.settings.set(CLAUDE_LIMIT_KEY, lim);
  return lim;
}
export async function claudeLimit(store: Store, now = new Date()): Promise<ClaudeLimit | undefined> {
  const lim = await store.settings.get<ClaudeLimit | null>(CLAUDE_LIMIT_KEY, null);
  return lim && new Date(lim.until) > now ? lim : undefined;
}

/** Grok agents draw on SuperGrok through the CLI, or on xAI credits through the API. */
export const grokPlan = (): PlanUsage["plan"] => ((process.env.GROK_MODE || "cli") === "api" ? "xai" : "supergrok");

export function weekStart(now = new Date()): Date {
  // Weekly pools reset on Monday 00:00 local time.
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function monthStart(now = new Date()): Date {
  // Monthly pools (credits) reset on the 1st.
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function usageSummary(store: Store, now = new Date()): Promise<UsageSummary> {
  const rows = await store.usage.since(monthStart(now));
  const week = weekStart(now).toISOString();
  const plans: PlanUsage[] = [];
  const build = (plan: PlanUsage["plan"], label: string, window: string, mine: UsageRecord[], used: (r: UsageRecord[]) => number): PlanUsage => {
    const per = new Map<string, PlanUsage["perAgent"][number]>();
    for (const r of mine) {
      const p = per.get(r.agentId) ?? { agentId: r.agentId, runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      p.runs++; p.inputTokens += r.inputTokens; p.outputTokens += r.outputTokens; p.costUsd += r.costUsd;
      per.set(r.agentId, p);
    }
    const share = Math.min(1, used(mine));
    return {
      plan, label, window, used: share,
      runs: mine.length,
      inputTokens: mine.reduce((a, r) => a + r.inputTokens, 0),
      outputTokens: mine.reduce((a, r) => a + r.outputTokens, 0),
      costUsd: mine.reduce((a, r) => a + r.costUsd, 0),
      throttled: share >= CAPS.pauseFirstAt,
      perAgent: [...per.values()].sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs),
    };
  };
  const cost = (m: UsageRecord[]) => m.reduce((a, r) => a + r.costUsd, 0);
  const claudeRows = rows.filter((r) => r.plan === "claude");
  if (CAPS.claudeMonthlyUsd > 0) plans.push(build("claude", "Claude plan", `monthly credit, $${CAPS.claudeMonthlyUsd}`, claudeRows, (m) => cost(m) / CAPS.claudeMonthlyUsd));
  else {
    // Signed in with the plan: no dollar pool. "Used" is all or nothing: the plan has said stop, until its reset time.
    const lim = await claudeLimit(store, now);
    const resets = lim ? new Date(lim.until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
    plans.push(build("claude", "Claude plan", lim ? `plan limit reached; resets ${resets}` : `plan windows (5-hour and weekly); $${cost(claudeRows.filter((r) => r.at >= week)).toFixed(2)} this week at list price`, claudeRows, () => (lim ? 1 : 0)));
  }
  if (grokPlan() === "supergrok") plans.push(build("supergrok", "SuperGrok (Grok CLI)", "weekly runs, est.", rows.filter((r) => r.plan === "supergrok" && r.at >= week), (m) => m.length / CAPS.grokWeeklyRuns));
  if (grokPlan() === "xai" || process.env.XAI_API_KEY || rows.some((r) => r.plan === "xai")) plans.push(build("xai", "xAI credits (X search, Grok API)", `monthly budget, $${CAPS.xaiMonthlyUsd}`, rows.filter((r) => r.plan === "xai"), (m) => cost(m) / CAPS.xaiMonthlyUsd));
  plans.push(build("chatgpt", "ChatGPT (Health team)", "manual", [], () => 0));
  plans.push(build("cursor", "Cursor (Jason 2.0)", "manual", [], () => 0));
  return { at: now.toISOString(), plans };
}

/** Decide whether an agent may run now given the plan's usage share and the agent's priority tier. */
export function allowedToRun(agent: AgentDef, summary: UsageSummary, direct: boolean): { ok: boolean; reason?: string } {
  if (direct || agent.priority === "always") return { ok: true };
  const plan = MODELS[agent.model].plan === "supergrok" ? grokPlan() : MODELS[agent.model].plan;
  const p = summary.plans.find((x) => x.plan === plan);
  if (!p) return { ok: true };
  const limit = agent.priority === "pause-first" ? CAPS.pauseFirstAt : CAPS.roomAt;
  if (p.used >= limit) {
    return { ok: false, reason: `${p.label} is at ${Math.round(p.used * 100)}% of its ${p.window}; ${agent.name} (${agent.priority}) waits.` };
  }
  return { ok: true };
}

export function agentOf(id: string): AgentDef | undefined {
  return AGENT_BY_ID[id];
}
