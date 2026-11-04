import { randomUUID } from "node:crypto";
import { bus } from "../events.js";
import { MODELS, type ModelSpec } from "../models.js";
import type { AgentDef, ModelKey } from "../registry/agents.js";
import type { Store } from "../store/types.js";
import { allowedToRun, usageSummary } from "../usage/caps.js";
import { claudeAgentSdkProvider, claudeApiProvider } from "./claude.js";
import { grokApiProvider, grokCliProvider } from "./grok.js";
import { mockProvider } from "./mock.js";
import { ProviderError, type AgentResult, type Provider } from "./types.js";
import type { ToolContext, ToolDef } from "../tools/index.js";

export * from "./types.js";
export { claudeProvider, claudeAgentSdkProvider, claudeApiProvider } from "./claude.js";
export { grokProvider, grokCliProvider, grokApiProvider } from "./grok.js";
export { mockProvider } from "./mock.js";

export interface RouterOptions {
  store: Store;
  /** Provider chains per provider id; the first available one that succeeds wins. */
  providers?: Partial<Record<"claude" | "grok", Provider[]>>;
}

export interface RunOptions {
  system: string;
  prompt: string;
  /** Phil asked for it directly: never throttled. */
  direct?: boolean;
  parentRunId?: string;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  maxTurns?: number;
  tools?: ToolDef[];
  toolContext?: ToolContext;
}

export interface RunOutcome extends AgentResult {
  runId: string;
  agentId: string;
  blocked?: string;
}

/** Builds the default provider chains from the environment. */
export function providersFromEnv(): Required<RouterOptions>["providers"] {
  if (process.env.JARVIS_MOCK === "1") {
    return { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] };
  }
  const claude: Provider[] = (process.env.CLAUDE_MODE || "agent-sdk") === "api"
    ? [claudeApiProvider(), claudeAgentSdkProvider()]
    : [claudeAgentSdkProvider(), claudeApiProvider()];
  const grok: Provider[] = (process.env.GROK_MODE || "cli") === "api"
    ? [grokApiProvider(), grokCliProvider()]
    : [grokCliProvider(), grokApiProvider()];
  if (process.env.JARVIS_MOCK_FALLBACK === "1") {
    claude.push(mockProvider("mock-claude"));
    grok.push(mockProvider("mock-grok"));
  }
  return { claude, grok };
}

/**
 * The model router: every agent names its model; the router sends the work to the provider for that model,
 * enforces the kill switch, pauses and usage caps, and records the run, the usage and the activity.
 */
export class ModelRouter {
  private store: Store;
  private providers: Required<RouterOptions>["providers"];

  constructor(opts: RouterOptions) {
    this.store = opts.store;
    this.providers = { ...providersFromEnv(), ...(opts.providers ?? {}) };
  }

  async modelForAgent(agent: AgentDef): Promise<ModelSpec> {
    const st = await this.store.agentState.get(agent.id);
    const key = (st?.modelOverride as ModelKey | undefined) || agent.model;
    return MODELS[key] ?? MODELS[agent.model];
  }

  async providerStatus(): Promise<Record<string, { ok: boolean; reason?: string }>> {
    const out: Record<string, { ok: boolean; reason?: string }> = {};
    for (const chain of Object.values(this.providers)) {
      for (const p of chain ?? []) out[p.id] = await p.available();
    }
    return out;
  }

  async run(agent: AgentDef, opts: RunOptions): Promise<RunOutcome> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const model = await this.modelForAgent(agent);
    const base: RunOutcome = { runId, agentId: agent.id, text: "", provider: model.provider, modelId: model.modelId ?? model.key, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };

    const block = async (reason: string) => {
      await this.store.runs.add({ id: runId, agentId: agent.id, prompt: opts.prompt, status: "blocked", error: reason, startedAt, finishedAt: new Date().toISOString(), parentRunId: opts.parentRunId });
      await this.log(agent.id, "system", `${agent.name} did not run: ${reason}`, runId);
      return { ...base, blocked: reason };
    };

    // Kill switch and pauses.
    const kill = await this.store.settings.get("killSwitch", { all: false, trading: false, agents: [] as string[] });
    if (kill.all) return block("the whole web is paused (kill switch)");
    if (kill.trading && (agent.id === "mayne" || agent.venture === "crypto")) return block("all trading is paused (kill switch)");
    const st = await this.store.agentState.get(agent.id);
    if (st?.paused || kill.agents.includes(agent.id)) return block(`${agent.name} is paused`);

    if (model.provider === "manual" || model.provider === "none") {
      return block(`${agent.name} runs on ${model.label}, which HQ can't call yet. Ask Phil to relay, or switch the model in agent settings.`);
    }

    // Usage caps.
    const summary = await usageSummary(this.store);
    const allowed = allowedToRun(agent, summary, opts.direct ?? false);
    if (!allowed.ok) return block(allowed.reason!);

    await this.store.runs.add({ id: runId, agentId: agent.id, provider: model.provider, modelId: model.modelId, prompt: opts.prompt, status: "running", startedAt, parentRunId: opts.parentRunId });
    await this.setStatus(agent.id, "working", `on ${model.label}`);

    const chain = this.providers[model.provider as "claude" | "grok"] ?? [];
    const errors: string[] = [];
    for (const p of chain) {
      const avail = await p.available();
      if (!avail.ok) { errors.push(`${p.id}: ${avail.reason}`); continue; }
      try {
        const res = await p.run({ agent, model, system: opts.system, prompt: opts.prompt, runId, onDelta: opts.onDelta, signal: opts.signal, maxTurns: opts.maxTurns, tools: opts.tools, toolContext: opts.toolContext });
        const finishedAt = new Date().toISOString();
        await this.store.runs.update(runId, { status: "done", output: res.text, provider: res.provider, modelId: res.modelId, finishedAt, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd });
        await this.store.usage.add({ id: randomUUID(), at: finishedAt, plan: model.plan, provider: res.provider, agentId: agent.id, modelId: res.modelId, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd, runId });
        await this.store.agentState.set(agent.id, { status: "idle", lastRunAt: finishedAt, lastRunId: runId, lastError: "" });
        bus.emitEvent({ type: "agent.status", agentId: agent.id, status: "idle", at: finishedAt, detail: `last run ${res.durationMs}ms on ${res.modelId}` });
        await this.log(agent.id, "run", `${agent.name} ran on ${res.modelId} (${res.provider}) in ${(res.durationMs / 1000).toFixed(1)}s`, runId, { prompt: opts.prompt.slice(0, 500), output: res.text.slice(0, 2000), tokens: res.inputTokens + res.outputTokens });
        console.log(`[run] ${agent.id} ok ${res.provider} ${res.modelId} ${res.durationMs}ms ${res.text.length}ch`);
        bus.emitEvent({ type: "usage", usage: await usageSummary(this.store) });
        return { ...base, ...res, runId, agentId: agent.id };
      } catch (e) {
        const msg = e instanceof ProviderError ? e.message : (e as Error).message;
        errors.push(`${p.id}: ${msg}`);
        console.warn(`[run] ${agent.id} failed on ${p.id}: ${msg.slice(0, 300)}`);
        if (opts.signal?.aborted) break;
      }
    }
    const err = errors.join(" | ") || `no provider configured for ${model.label}`;
    const finishedAt = new Date().toISOString();
    await this.store.runs.update(runId, { status: "error", error: err, finishedAt });
    await this.store.agentState.set(agent.id, { status: "error", lastRunAt: finishedAt, lastRunId: runId, lastError: err });
    bus.emitEvent({ type: "agent.status", agentId: agent.id, status: "error", at: finishedAt, detail: err.slice(0, 200) });
    await this.log(agent.id, "error", `${agent.name} failed: ${err.slice(0, 300)}`, runId);
    return { ...base, blocked: err };
  }

  async setStatus(agentId: string, status: "idle" | "working" | "waiting" | "error" | "paused", detail?: string) {
    await this.store.agentState.set(agentId, { status, detail });
    bus.emitEvent({ type: "agent.status", agentId, status, detail, at: new Date().toISOString() });
  }

  async log(agentId: string, kind: "run" | "delegate" | "approval" | "decision" | "schedule" | "system" | "error" | "memory", summary: string, runId?: string, detail?: Record<string, unknown>) {
    const entry = { id: randomUUID(), at: new Date().toISOString(), agentId, kind, summary, detail, runId };
    await this.store.activity.add(entry);
    bus.emitEvent({ type: "activity", entry });
    return entry;
  }
}
