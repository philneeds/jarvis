import { randomUUID } from "node:crypto";
import { bus, type Approval, type ChatMessage, type SystemStatus } from "../events.js";
import { AGENTS, findAgent, getAgent, type AgentDef } from "../registry/index.js";
import { ModelRouter } from "../router/index.js";
import type { Store } from "../store/types.js";
import { usageSummary } from "../usage/caps.js";
import { extractBlocks, parsePlan } from "./blocks.js";
import { agentSystemPrompt, briefPrompt, jarvisSystemPrompt, planPrompt, synthesisPrompt } from "./prompts.js";

export interface JarvisOptions {
  store: Store;
  router?: ModelRouter;
  /** Notify Phil's phone: called for new approvals and errors. */
  notify?: (title: string, body: string) => Promise<void>;
}

export class Jarvis {
  readonly store: Store;
  readonly router: ModelRouter;
  private notify?: JarvisOptions["notify"];

  constructor(opts: JarvisOptions) {
    this.store = opts.store;
    this.router = opts.router ?? new ModelRouter({ store: opts.store });
    this.notify = opts.notify;
  }

  // ---- Chat -------------------------------------------------------------

  /** Handle one message from Phil. Returns the messages produced (already stored and broadcast). */
  async handle(text: string): Promise<ChatMessage[]> {
    const trimmed = text.trim();
    if (!trimmed) return [];
    await this.say({ role: "phil", text: trimmed });
    const out: ChatMessage[] = [];

    if (trimmed.startsWith("/")) {
      const reply = await this.command(trimmed);
      out.push(await this.say({ role: "jarvis", text: reply }));
      return out;
    }

    const mention = trimmed.match(/^@([\w.-]+)\s*(.*)$/s);
    if (mention) {
      const agent = findAgent(mention[1]!);
      if (!agent) {
        out.push(await this.say({ role: "jarvis", text: `No agent called "${mention[1]}". Try a name from the web, like @stella or @munger.` }));
        return out;
      }
      if (agent.id === "jarvis") return this.converse(mention[2] || trimmed, out);
      const r = await this.runAgent(agent, mention[2] || "Give Phil a status update in your own voice.", { direct: true });
      out.push(await this.say({ role: "agent", agentId: agent.id, text: r.blocked ? `(${agent.name} did not run: ${r.blocked})` : r.text, runId: r.runId }));
      return out;
    }

    return this.converse(trimmed, out);
  }

  private async converse(userText: string, out: ChatMessage[]): Promise<ChatMessage[]> {
    const jarvis = getAgent("jarvis")!;
    const memory = await this.store.memory.list();
    const status = await this.systemStatus();
    const recent = (await this.store.chat.list(12)).slice(0, -1).map((m) => `${m.role === "phil" ? "Phil" : m.agentId ?? "Jarvis"}: ${m.text.slice(0, 300)}`).join("\n");
    const system = jarvisSystemPrompt(memory, status.text);

    const planRun = await this.router.run(jarvis, { system, prompt: planPrompt(userText, recent), direct: true, maxTurns: 1 });
    if (planRun.blocked) {
      out.push(await this.say({ role: "jarvis", text: `I can't think right now: ${planRun.blocked}` }));
      return out;
    }
    const plan = parsePlan(planRun.text);
    const seen = new Set<string>();
    const delegations = plan.delegate
      .map((d) => ({ ...d, agent: getAgent(d.agent) ?? findAgent(d.agent) }))
      .filter((d): d is { agent: AgentDef; task: string } => !!d.agent && d.agent.id !== "jarvis" && !seen.has(d.agent.id) && !!seen.add(d.agent.id))
      .slice(0, 4);

    if (!delegations.length) {
      const { text, approvals, remember } = extractBlocks(plan.reply ?? planRun.text);
      await this.absorb(jarvis, approvals, remember, planRun.runId);
      out.push(await this.say({ role: "jarvis", text: text || "Done.", runId: planRun.runId }));
      return out;
    }

    if (plan.reply) out.push(await this.say({ role: "jarvis", text: plan.reply, runId: planRun.runId }));
    for (const d of delegations) await this.router.log("jarvis", "delegate", `Jarvis → ${d.agent.name}: ${d.task.slice(0, 200)}`, planRun.runId);

    const reports = await Promise.all(delegations.map(async (d) => {
      const r = await this.runAgent(d.agent, d.task, { direct: true, parentRunId: planRun.runId, from: "Jarvis" });
      return { agent: d.agent, task: d.task, text: r.text, blocked: r.blocked };
    }));

    const synth = await this.router.run(jarvis, { system, prompt: synthesisPrompt(userText, reports), direct: true, parentRunId: planRun.runId, maxTurns: 1 });
    const final = synth.blocked
      ? reports.map((r) => `${r.agent.name}: ${r.blocked ? `did not run (${r.blocked})` : r.text}`).join("\n\n")
      : synth.text;
    const { text, approvals, remember } = extractBlocks(final);
    await this.absorb(jarvis, approvals, remember, synth.runId);
    out.push(await this.say({ role: "jarvis", text, runId: synth.runId, via: reports.map((r) => r.agent.id) }));
    return out;
  }

  /** Run one agent on a task with its persona, memory and safety rules; queue approvals and memories it emits. */
  async runAgent(agent: AgentDef, task: string, opts: { direct?: boolean; parentRunId?: string; from?: string } = {}) {
    const memory = [...(await this.store.memory.list("phil")), ...(await this.store.memory.list(`venture:${agent.venture}`)), ...(await this.store.memory.list(`agent:${agent.id}`))];
    const system = agentSystemPrompt(agent, memory);
    const prompt = `${opts.from ?? "Phil"} asks: ${task}`;
    const r = await this.router.run(agent, { system, prompt, direct: opts.direct, parentRunId: opts.parentRunId, maxTurns: 1 });
    if (r.blocked) return r;
    const { text, approvals, remember } = extractBlocks(r.text);
    await this.absorb(agent, approvals, remember, r.runId);
    return { ...r, text };
  }

  private async absorb(agent: AgentDef, approvals: ReturnType<typeof extractBlocks>["approvals"], remember: ReturnType<typeof extractBlocks>["remember"], runId?: string) {
    for (const a of approvals) await this.requestApproval({ agentId: agent.id, ...a, runId });
    for (const m of remember) {
      await this.store.memory.set({ scope: m.scope, key: m.key, value: m.value, source: agent.id });
      await this.router.log(agent.id, "memory", `${agent.name} remembered [${m.scope}] ${m.key}`, runId, { value: m.value });
    }
  }

  async say(m: Omit<ChatMessage, "id" | "at">): Promise<ChatMessage> {
    const msg: ChatMessage = { id: randomUUID(), at: new Date().toISOString(), ...m };
    await this.store.chat.add(msg);
    bus.emitEvent({ type: "chat.message", message: msg });
    return msg;
  }

  // ---- Commands -----------------------------------------------------------

  async command(line: string): Promise<string> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch ((cmd ?? "").toLowerCase()) {
      case "help":
        return "Commands: /brief (morning rundown), /status (who's doing what), /pause [agent|trading|all], /resume [agent|trading|all], /approvals, /usage, /memory. Talk to any agent with @name.";
      case "brief":
        return this.brief();
      case "status": {
        const s = await this.systemStatus();
        const states = await this.store.agentState.all();
        const working = states.filter((x) => x.status === "working").map((x) => x.id);
        const errors = states.filter((x) => x.status === "error").map((x) => x.id);
        const paused = states.filter((x) => x.paused).map((x) => x.id);
        const pending = (await this.store.approvals.list("pending")).length;
        return [`Status ${s.level.toUpperCase()}: ${s.text}.`, `Working: ${working.join(", ") || "nobody"}.`, `Errors: ${errors.join(", ") || "none"}.`, `Paused: ${paused.join(", ") || "none"}${s.killSwitch.all ? " (whole web paused)" : s.killSwitch.trading ? " (trading paused)" : ""}.`, `${pending} approval(s) waiting.`].join(" ");
      }
      case "pause":
        return this.pause(arg || "all", true);
      case "resume":
        return this.pause(arg || "all", false);
      case "approvals": {
        const p = await this.store.approvals.list("pending");
        return p.length ? `${p.length} waiting:\n` + p.map((a) => `- [${a.kind}] ${a.agentId}: ${a.title}`).join("\n") : "Nothing waiting for you.";
      }
      case "usage": {
        const u = await usageSummary(this.store);
        return u.plans.filter((p) => p.window !== "manual").map((p) => `${p.label}: ${Math.round(p.used * 100)}% of ${p.window}, ${p.runs} runs${p.throttled ? " (scouts paused)" : ""}`).join("\n");
      }
      case "memory": {
        const m = await this.store.memory.list();
        return m.length ? m.slice(0, 40).map((x) => `- [${x.scope}] ${x.key}: ${x.value}`).join("\n") : "Memory is empty.";
      }
      default:
        return `Unknown command /${cmd}. Try /help.`;
    }
  }

  async pause(target: string, paused: boolean): Promise<string> {
    const kill = await this.store.settings.get("killSwitch", { all: false, trading: false, agents: [] as string[] });
    const t = target.toLowerCase().replace(/^@/, "");
    if (t === "all") {
      kill.all = paused;
    } else if (t === "trading") {
      kill.trading = paused;
    } else {
      const agent = findAgent(t);
      if (!agent) return `No agent called "${target}".`;
      kill.agents = kill.agents.filter((a) => a !== agent.id);
      if (paused) kill.agents.push(agent.id);
      await this.store.agentState.set(agent.id, { paused, status: paused ? "paused" : "idle" });
      bus.emitEvent({ type: "agent.status", agentId: agent.id, status: paused ? "paused" : "idle", at: new Date().toISOString() });
    }
    await this.store.settings.set("killSwitch", kill);
    await this.router.log("jarvis", "system", `${paused ? "Paused" : "Resumed"} ${t}`);
    bus.emitEvent({ type: "system", status: await this.systemStatus() });
    return paused ? `Paused ${t === "all" ? "the whole web" : t === "trading" ? "all trading" : t}.` : `Resumed ${t === "all" ? "the whole web" : t === "trading" ? "all trading" : t}.`;
  }

  async brief(): Promise<string> {
    const jarvis = getAgent("jarvis")!;
    const states = await this.store.agentState.all();
    const recent = (await this.store.activity.list({ limit: 15 })).map((e) => `${e.at.slice(0, 16)} ${e.summary}`);
    const prompt = briefPrompt({
      pending: (await this.store.approvals.list("pending")).length,
      working: states.filter((x) => x.status === "working").map((x) => x.id),
      errors: states.filter((x) => x.status === "error").map((x) => x.id),
      recent,
    }, new Date());
    const memory = await this.store.memory.list();
    const r = await this.router.run(jarvis, { system: jarvisSystemPrompt(memory, (await this.systemStatus()).text), prompt, direct: true, maxTurns: 1 });
    if (r.blocked) return `No brief: ${r.blocked}`;
    const { text, approvals, remember } = extractBlocks(r.text);
    await this.absorb(jarvis, approvals, remember, r.runId);
    await this.store.settings.set("lastBrief", { at: new Date().toISOString(), text });
    return text;
  }

  // ---- Approvals ----------------------------------------------------------

  async requestApproval(a: Omit<Approval, "id" | "at" | "status">): Promise<Approval> {
    const approval: Approval = { id: randomUUID(), at: new Date().toISOString(), status: "pending", ...a };
    await this.store.approvals.add(approval);
    await this.router.setStatus(a.agentId, "waiting", `waiting on Phil: ${a.title}`);
    await this.router.log(a.agentId, "approval", `${getAgent(a.agentId)?.name ?? a.agentId} asked for approval: ${a.title}`, a.runId, { kind: a.kind, body: a.body });
    bus.emitEvent({ type: "approval.new", approval });
    await this.notify?.(`Approval: ${approval.title}`, approval.body.slice(0, 200)).catch(() => undefined);
    return approval;
  }

  async decide(id: string, decision: "approved" | "rejected" | "edited", note?: string, edits?: { body?: string; payload?: Record<string, unknown> }): Promise<Approval | undefined> {
    const a = await this.store.approvals.update(id, { status: decision, decidedAt: new Date().toISOString(), note, ...(edits ?? {}) });
    if (!a) return undefined;
    const stillWaiting = (await this.store.approvals.list("pending")).some((p) => p.agentId === a.agentId);
    if (!stillWaiting) await this.router.setStatus(a.agentId, "idle");
    await this.router.log(a.agentId, "decision", `Phil ${decision} "${a.title}"${note ? ` — ${note}` : ""}`, a.runId, { approvalId: a.id, kind: a.kind });
    bus.emitEvent({ type: "approval.decided", approval: a });
    // Phase 0 has no outbound connectors: an approval records the decision; the executing connector (email, X, CRM, wallet) hooks in here in later phases.
    await this.say({ role: "system", text: `${decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Edited and approved"}: ${a.title} (${getAgent(a.agentId)?.name ?? a.agentId})` });
    return a;
  }

  // ---- Status -------------------------------------------------------------

  async systemStatus(): Promise<SystemStatus> {
    const kill = await this.store.settings.get("killSwitch", { all: false, trading: false, agents: [] as string[] });
    const phase = await this.store.settings.get("phase", 0);
    const states = await this.store.agentState.all();
    const errors = states.filter((s) => s.status === "error").length;
    const usage = await usageSummary(this.store);
    const hot = usage.plans.some((p) => p.used >= 0.9);
    const warm = usage.plans.some((p) => p.used >= 0.7);
    let level: SystemStatus["level"] = "green", text = "all agents running";
    if (kill.all) { level = "red"; text = "whole web paused"; }
    else if (errors >= 3 || hot) { level = "orange"; text = hot ? "a plan is near its cap" : `${errors} agents in error`; }
    else if (errors > 0 || warm || kill.trading || kill.agents.length) { level = "yellow"; text = kill.trading ? "trading paused" : errors ? `${errors} agent in error` : warm ? "scouts backing off" : `${kill.agents.length} agent(s) paused`; }
    return { level, text, killSwitch: kill, phase, at: new Date().toISOString() };
  }

  /** Live snapshot for the Agent Web: every agent with its status, phase and model. */
  async snapshot() {
    const states = new Map((await this.store.agentState.all()).map((s) => [s.id, s]));
    const phase = await this.store.settings.get("phase", 0);
    return AGENTS.map((a) => {
      const st = states.get(a.id);
      const model = st?.modelOverride ?? a.model;
      return { ...a, live: a.phase <= phase, model, status: st?.paused ? "paused" : (st?.status ?? "idle"), lastRunAt: st?.lastRunAt, lastError: st?.lastError, detail: st?.detail };
    });
  }
}
