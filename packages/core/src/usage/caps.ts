import type { PlanUsage, UsageSummary } from "../events.js";
import type { AgentDef } from "../registry/agents.js";
import { AGENT_BY_ID } from "../registry/index.js";
import type { Store, UsageRecord } from "../store/types.js";
import { MODELS } from "../models.js";

/**
 * Usage rationing. Both plans have caps, so work is rationed by priority instead of paying for API calls.
 * The caps are estimates until the exact plans are confirmed (open question in the scope doc):
 *   CLAUDE_WEEKLY_TOKENS   estimated weekly token pool on Phil's Claude plan (default 15M)
 *   GROK_WEEKLY_RUNS       estimated weekly prompt pool on SuperGrok, shared with Phil's own chats (default 400)
 * Priority rules:
 *   always      Jarvis, Stella's team, anything Phil asks for directly: never throttled
 *   room        briefs, holdings reviews, research: hold when a pool passes 90%
 *   pause-first scheduled scanners: back off when a pool passes 70%
 */
export const CAPS = {
  claudeWeeklyTokens: Number(process.env.CLAUDE_WEEKLY_TOKENS ?? 15_000_000),
  grokWeeklyRuns: Number(process.env.GROK_WEEKLY_RUNS ?? 400),
  pauseFirstAt: Number(process.env.THROTTLE_PAUSE_FIRST_AT ?? 0.7),
  roomAt: Number(process.env.THROTTLE_ROOM_AT ?? 0.9),
};

export function weekStart(now = new Date()): Date {
  // Weekly pools reset on Monday 00:00 local time.
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function usageSummary(store: Store, now = new Date()): Promise<UsageSummary> {
  const rows = await store.usage.since(weekStart(now));
  const plans: PlanUsage[] = [];
  const build = (plan: PlanUsage["plan"], label: string, window: string, used: (r: UsageRecord[]) => number): PlanUsage => {
    const mine = rows.filter((r) => r.plan === plan);
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
      perAgent: [...per.values()].sort((a, b) => b.runs - a.runs),
    };
  };
  plans.push(build("claude", "Claude (Phil's plan)", "weekly, est.", (m) => m.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0) / CAPS.claudeWeeklyTokens));
  plans.push(build("supergrok", "SuperGrok", "weekly pool, est.", (m) => m.length / CAPS.grokWeeklyRuns));
  plans.push(build("chatgpt", "ChatGPT (Health team)", "manual", () => 0));
  plans.push(build("cursor", "Cursor (Jason 2.0)", "manual", () => 0));
  return { at: now.toISOString(), plans };
}

/** Decide whether an agent may run now given the plan's usage share and the agent's priority tier. */
export function allowedToRun(agent: AgentDef, summary: UsageSummary, direct: boolean): { ok: boolean; reason?: string } {
  if (direct || agent.priority === "always") return { ok: true };
  const plan = MODELS[agent.model].plan;
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
