import type { PlanUsage, UsageSummary } from "../events.js";
import type { AgentDef } from "../registry/agents.js";
import { AGENT_BY_ID } from "../registry/index.js";
import type { Store, UsageRecord } from "../store/types.js";
import { MODELS } from "../models.js";

/**
 * Usage rationing. Work is rationed by priority against each pool so a busy month degrades gracefully instead of
 * stopping or overspending:
 *   CLAUDE_MONTHLY_USD   the Agent SDK credit on Phil's Claude plan, per month (Pro $20, Max 5x $100, Max 20x $200).
 *                        Every Claude run reports its list-price cost; the pool is that cost against the credit.
 *   XAI_MONTHLY_USD      what HQ may spend at xAI per month: X searches, and Grok runs when GROK_MODE=api (default 30).
 *   GROK_WEEKLY_RUNS     when GROK_MODE=cli, the Grok Build CLI runs HQ may use per week on SuperGrok (default 400).
 * Priority rules:
 *   always      Jarvis, Stella's team, anything Phil asks for directly: never throttled
 *   room        briefs, holdings reviews, research: hold when a pool passes 90%
 *   pause-first scheduled scanners: back off when a pool passes 70%
 */
export const CAPS = {
  claudeMonthlyUsd: Number(process.env.CLAUDE_MONTHLY_USD ?? 100),
  xaiMonthlyUsd: Number(process.env.XAI_MONTHLY_USD ?? 30),
  grokWeeklyRuns: Number(process.env.GROK_WEEKLY_RUNS ?? 400),
  pauseFirstAt: Number(process.env.THROTTLE_PAUSE_FIRST_AT ?? 0.7),
  roomAt: Number(process.env.THROTTLE_ROOM_AT ?? 0.9),
};

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
  plans.push(build("claude", "Claude plan", `monthly credit, $${CAPS.claudeMonthlyUsd}`, rows.filter((r) => r.plan === "claude"), (m) => cost(m) / CAPS.claudeMonthlyUsd));
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
