import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { bus, type Approval, type AttentionItem, type ChatMessage, type Goal, type SystemStatus } from "../events.js";
import { AGENTS, CHARTERS, findAgent, getAgent, type AgentDef } from "../registry/index.js";
import { ModelRouter } from "../router/index.js";
import type { MemoryItem, MetricPoint, RecordItem, Store } from "../store/types.js";
import { usageSummary } from "../usage/caps.js";
import { extractBlocks, parsePlan } from "./blocks.js";
import { agentSystemPrompt, briefPrompt, condensePrompt, jarvisSystemPrompt, leadBriefTask, planPrompt, synthesisPrompt } from "./prompts.js";
import { getAgentConfig } from "../config.js";
import { VENTURES, type VentureId } from "../registry/ventures.js";
import { VENTURE_DASH, recordKind } from "../ventures/dashboards.js";
import { TOOLS } from "../tools/index.js";

export interface JarvisOptions {
  store: Store;
  router?: ModelRouter;
  /** Notify Phil's phone: called for new approvals and errors. */
  notify?: (title: string, body: string) => Promise<void>;
}

/** Runs an approved action. Registered by the payload's `action` name; connectors add theirs. */
export type Executor = (approval: Approval, jarvis: Jarvis) => Promise<string | void>;
export type Describer = (payload: Record<string, unknown>, approval: Pick<Approval, "agentId" | "payload" | "kind">) => string;
export type Normalizer = (payload: Record<string, unknown>, agentId: string) => Promise<Record<string, unknown> | void>;
/**
 * Spoken addressing: "ask Stella what's open", "tell Monica to move my 3pm", "Stella, status?" or "hey Jarvis, get
 * Oscar to..." go straight to that agent, like an @mention typed. Only a name that is an agent counts, so
 * "tell me about..." or "ask around" still go to Jarvis.
 */
export function spokenAddress(text: string): RegExpMatchArray | null {
  const t = text.replace(/^(?:hey|ok|okay|yo)?[,\s]*jarvis[,:\s]+/i, "");
  const m = t.match(/^(?:(?:can|could|would) you )?(?:please )?(?:ask|tell|get|have|ping|let)\s+([A-Za-z][\w.'-]*)(?:\s+to)?[,:\s]+(.+)$/is) ?? t.match(/^([A-Za-z][\w.'-]*)[,:]\s+(.+)$/s);
  if (!m) return null;
  const agent = findAgent(m[1]!);
  if (!agent || agent.id === "jarvis") return null;
  // Looks like a typed @mention so the same path handles it.
  return [m[0]!, agent.id, m[2]!] as unknown as RegExpMatchArray;
}

/** Actions that reach another person. */
const OUTBOUND_ACTIONS = new Set(["gmail.send", "x.post", "x.reply", "x.dm"]);

/** Does this approval reach anyone besides Phil: a message, a post, or a calendar change other people will see? */
export function isOutbound(a: Pick<Approval, "kind" | "payload">): boolean {
  const p = (a.payload ?? {}) as { action?: unknown; attendees?: unknown; guests?: unknown };
  if (a.kind === "send" || a.kind === "post") return true;
  if (typeof p.action === "string" && OUTBOUND_ACTIONS.has(p.action)) return true;
  if (Array.isArray(p.attendees) && p.attendees.length) return true;
  if (Array.isArray(p.guests) && p.guests.length) return true;
  // An action no connector recognises is treated as outbound: when unsure, ask.
  return typeof p.action !== "string" || !/^(gmail\.(archive|label|trash)|calendar\.(create|update|delete)|memory\.replace|record\.)/.test(p.action);
}

/** Something Phil deleted, kept for a while so he can undo it. */
interface TrashEntry { id: string; at: string; kind: "memory" | "record" | "metric" | "goal"; label: string; data: unknown; index?: number }

const clampPct = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);

/** Which payload field holds the text Phil edits on the card, per action. */
const TEXT_FIELD: Record<string, string> = { "gmail.send": "body", "x.post": "text", "x.reply": "text", "x.dm": "text" };

export class Jarvis {
  readonly store: Store;
  readonly router: ModelRouter;
  private notify?: JarvisOptions["notify"];
  private executors = new Map<string, Executor>();
  /** Plain words for what an action does with a given payload; shown to Phil before he approves. */
  private describers = new Map<string, Describer>();
  /** Extra tools from connectors, by name. */
  readonly connectorTools = new Map<string, import("../tools/index.js").ToolDef>();
  private promptHints: string[] = [];

  constructor(opts: JarvisOptions) {
    this.store = opts.store;
    this.router = opts.router ?? new ModelRouter({ store: opts.store });
    this.notify = opts.notify;
    this.executors.set("memory.replace", async (a) => {
      const keep = (a.payload?.keep ?? []) as { scope: string; key: string; value: string }[];
      const current = await this.store.memory.list();
      for (const m of current) await this.store.memory.remove(m.scope, m.key);
      for (const k of keep) await this.store.memory.set({ scope: k.scope, key: k.key, value: k.value, source: a.agentId });
      return `Memory condensed: ${current.length} → ${keep.length} items.`;
    });
    this.describers.set("memory.replace", (p) => `Jarvis's memory is replaced with the ${Array.isArray(p.keep) ? p.keep.length : "listed"} items above${typeof p.before === "number" ? `, dropping ${p.before - (Array.isArray(p.keep) ? p.keep.length : 0)}` : ""}. The old list is gone.`);
  }

  /** Checks run when an approval is requested; a failing check refuses it with a reason (used by Mayne's limits). */
  private preflights: ((a: Omit<Approval, "id" | "at" | "status">) => Promise<string | undefined>)[] = [];
  onApprovalRequested(fn: (a: Omit<Approval, "id" | "at" | "status">) => Promise<string | undefined>) { this.preflights.push(fn); }

  /** Register what happens when an approval with payload.action = name is approved. */
  onApproved(action: string, fn: Executor) { this.executors.set(action, fn); }

  /** Plug in a connector: its tools become available in agent settings, its actions run on approval. */
  addConnector(c: { tools(): import("../tools/index.js").ToolDef[]; executors(): Record<string, Executor>; describe?(): Record<string, Describer>; normalize?: Normalizer }, hint?: string) {
    for (const t of c.tools()) this.connectorTools.set(t.name, t);
    for (const [k, fn] of Object.entries(c.executors())) this.executors.set(k, fn);
    for (const [k, fn] of Object.entries(c.describe?.() ?? {})) this.describers.set(k, fn);
    if (c.normalize) this.normalizers.push(c.normalize.bind(c));
    if (hint) this.promptHints.push(hint);
  }

  /** Connectors fill in what an agent left implicit (for example which account sends) before Phil sees the card. */
  private normalizers: Normalizer[] = [];

  /** What approving does, in Phil's words, worked out from the payload rather than taken from the agent. */
  effectOf(a: Pick<Approval, "agentId" | "payload" | "kind">): string {
    const who = getAgent(a.agentId)?.name ?? a.agentId;
    const action = (a.payload as { action?: unknown } | undefined)?.action;
    if (typeof action !== "string") return `Nothing happens on its own: approving only records your decision. ${who} can't act on this one, so if you want it done, do it by hand or ask ${who} for a version HQ can send.`;
    const d = this.describers.get(action);
    if (!d) return this.executors.has(action) ? `Runs "${action}" with the details shown.` : `No connector handles "${action}" yet, so approving records your decision and nothing is sent or changed.`;
    try { return d(a.payload ?? {}, a); } catch { return `Runs "${action}" with the details shown.`; }
  }

  /** Phil's edit on the card changes the thing that goes out, not just the description. */
  private applyEdit(a: Pick<Approval, "payload" | "body">, body: string): { body: string; payload?: Record<string, unknown> } {
    const action = (a.payload as { action?: unknown } | undefined)?.action;
    const field = typeof action === "string" ? (TEXT_FIELD[action] ?? (action.startsWith("x.") ? "text" : undefined)) : undefined;
    return { body, payload: field && a.payload ? { ...a.payload, [field]: body } : a.payload };
  }

  /** Every tool an agent could be given: built-in plus connectors. */
  allTools() { return [...TOOLS, ...this.connectorTools.values()]; }

  // ---- Chat -------------------------------------------------------------

  /** The conversation a reply belongs to, carried through async work so every say() in it is tagged. */
  private convo = new AsyncLocalStorage<{ channel: ChatMessage["channel"]; replyTo: string }>();

  /**
   * Submit a message from Phil and return at once with his message; the work continues in the background and
   * every reply (ack, progress, final) arrives as a chat.message event tagged with replyTo = his message id.
   */
  async submit(text: string, opts: { channel?: ChatMessage["channel"] } = {}): Promise<{ message: ChatMessage; done: Promise<ChatMessage[]> }> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("empty message");
    const message = await this.say({ role: "phil", text: trimmed, channel: opts.channel ?? "hq" });
    const done = this.convo.run({ channel: opts.channel ?? "hq", replyTo: message.id }, () => this.handleStored(trimmed).catch(async (e) => [await this.say({ role: "jarvis", text: `Something broke on my side: ${(e as Error).message}`, kind: "final" })]));
    return { message, done };
  }

  /** Handle one message from Phil and wait for everything. Returns the replies (already stored and broadcast). */
  async handle(text: string, opts: { channel?: ChatMessage["channel"] } = {}): Promise<ChatMessage[]> {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const { done } = await this.submit(trimmed, opts);
    return done;
  }

  private async handleStored(trimmed: string): Promise<ChatMessage[]> {
    const out: ChatMessage[] = [];

    if (trimmed.startsWith("/")) {
      const reply = await this.command(trimmed);
      out.push(await this.say({ role: "jarvis", text: reply, kind: "final" }));
      return out;
    }

    const mention = trimmed.match(/^@([\w.-]+)\s*(.*)$/s) ?? spokenAddress(trimmed);
    if (mention) {
      const agent = findAgent(mention[1]!);
      if (!agent) {
        out.push(await this.say({ role: "jarvis", text: `No agent called "${mention[1]}". Try a name from the web, like @stella or @munger.`, kind: "final" }));
        return out;
      }
      if (agent.id === "jarvis") return this.converse(mention[2] || trimmed, out);
      // Say who's on it right away; the agent's answer follows when it lands.
      out.push(await this.say({ role: "jarvis", text: `${agent.name} is on it.`, kind: "ack" }));
      const r = await this.runAgent(agent, mention[2] || "Give Phil a status update in your own voice.", { direct: true });
      out.push(await this.say({ role: "agent", agentId: agent.id, text: r.blocked ? `(${agent.name} did not run: ${r.blocked})` : r.text, runId: r.runId, kind: "final" }));
      return out;
    }

    return this.converse(trimmed, out);
  }

  /** How long a delegated agent may take before Jarvis answers without it (its part arrives later). */
  static DELEGATE_TIMEOUT_MS = Number(process.env.JARVIS_DELEGATE_TIMEOUT_MS ?? 180_000);

  private async converse(userText: string, out: ChatMessage[]): Promise<ChatMessage[]> {
    const jarvis = getAgent("jarvis")!;
    const memory = await this.store.memory.list();
    const status = await this.systemStatus();
    const recent = (await this.store.chat.list(12)).slice(0, -1).map((m) => `${m.role === "phil" ? "Phil" : m.agentId ?? "Jarvis"}: ${m.text.slice(0, 300)}`).join("\n");
    const system = jarvisSystemPrompt(memory, status.text, await this.attentionText());

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
      out.push(await this.say({ role: "jarvis", text: text || "Done.", runId: planRun.runId, kind: "final" }));
      return out;
    }

    // Ack within seconds: who's being asked and that the answer follows.
    const names = delegations.map((d) => d.agent.name);
    const ack = plan.reply?.trim() || `On it. Asking ${names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1]}; I'll be back within a couple of minutes.`;
    out.push(await this.say({ role: "jarvis", text: ack, runId: planRun.runId, kind: "ack" }));
    for (const d of delegations) await this.router.log("jarvis", "delegate", `Jarvis → ${d.agent.name}: ${d.task.slice(0, 200)}`, planRun.runId);

    // Each delegate is time-boxed. A slow one doesn't hold the answer: Jarvis answers with what's in, names who's still
    // working, and that agent's report posts on its own when it lands.
    type Report = { agent: AgentDef; task: string; text: string; blocked?: string; late?: boolean };
    const runs = delegations.map((d) => this.runAgent(d.agent, d.task, { direct: true, parentRunId: planRun.runId, from: "Jarvis" }).then((r) => ({ agent: d.agent, task: d.task, text: r.text, blocked: r.blocked }) as Report));
    const reports: Report[] = await Promise.all(runs.map((pr, i) => Promise.race([pr, new Promise<Report>((res) => setTimeout(() => res({ agent: delegations[i]!.agent, task: delegations[i]!.task, text: "", blocked: "still working; their report will follow", late: true }), Jarvis.DELEGATE_TIMEOUT_MS))])));
    reports.forEach((r, i) => { if (r.late) void runs[i]!.then(async (late) => { await this.say({ role: "agent", agentId: late.agent.id, text: late.blocked ? `(${late.agent.name} did not run: ${late.blocked})` : `Late report: ${late.text}`, kind: "progress", via: ["jarvis"] }); }); });

    const synth = await this.router.run(jarvis, { system, prompt: synthesisPrompt(userText, reports), direct: true, parentRunId: planRun.runId, maxTurns: 1, onDelta: this.streamer("jarvis") });
    const final = synth.blocked
      ? reports.map((r) => `${r.agent.name}: ${r.blocked ? `did not run (${r.blocked})` : r.text}`).join("\n\n")
      : synth.text;
    const { text, approvals, remember } = extractBlocks(final);
    await this.absorb(jarvis, approvals, remember, synth.runId);
    out.push(await this.say({ role: "jarvis", text, runId: synth.runId, via: reports.map((r) => r.agent.id), kind: "final" }));
    return out;
  }

  /** Run one agent on a task with its persona, memory and safety rules; queue approvals and memories it emits. */
  async runAgent(agent: AgentDef, task: string, opts: { direct?: boolean; parentRunId?: string; from?: string; depth?: number; noBlocks?: boolean } = {}) {
    const memory = [...(await this.store.memory.list("phil")), ...(await this.store.memory.list(`venture:${agent.venture}`)), ...(await this.store.memory.list(`agent:${agent.id}`))];
    const cfg = await getAgentConfig(this.store, agent.id);
    const tools = this.allTools().filter((t) => cfg.tools.includes(t.name));
    const system = agentSystemPrompt(agent, memory, cfg.persona, tools) + (tools.some((t) => this.connectorTools.has(t.name)) && this.promptHints.length ? `\n\n${this.promptHints.join("\n")}` : "");
    const prompt = `${opts.from ?? "Phil"} asks: ${task}`;
    const r = await this.router.run(agent, { system, prompt, direct: opts.direct, parentRunId: opts.parentRunId, tools, toolContext: { store: this.store, agentId: agent.id }, onDelta: this.streamer(agent.id) });
    if (r.blocked) return r;
    if (opts.noBlocks) return r; // the caller reads the reply itself (approval Q&A)
    const { text, approvals, remember, metrics, records, handoffs, attention } = extractBlocks(r.text);
    await this.absorb(agent, approvals, remember, r.runId, metrics, records);
    for (const a of attention) await this.raiseAttention({ ...a, agentId: agent.id, source: { runId: r.runId } });
    // Hand-offs: something that isn't this agent's job goes to the agent whose job it is; the receiver may hand back once.
    if (handoffs.length && (opts.depth ?? 0) < 2) {
      for (const h of handoffs.slice(0, 6)) {
        const to = getAgent(h.agent) ?? findAgent(h.agent);
        if (!to || to.id === agent.id || to.id === "jarvis") continue;
        await this.router.log(agent.id, "delegate", `${agent.name} → ${to.name}: ${h.task.slice(0, 200)}`, r.runId);
        const hr = await this.runAgent(to, h.task, { direct: opts.direct, parentRunId: r.runId, from: agent.name, depth: (opts.depth ?? 0) + 1 });
        await this.say({ role: "agent", agentId: to.id, text: hr.blocked ? `(${to.name} did not run: ${hr.blocked})` : hr.text, runId: hr.runId, via: [agent.id] });
      }
    }
    return { ...r, text };
  }

  private async absorb(agent: AgentDef, approvals: ReturnType<typeof extractBlocks>["approvals"], remember: ReturnType<typeof extractBlocks>["remember"], runId?: string, metrics: ReturnType<typeof extractBlocks>["metrics"] = [], records: ReturnType<typeof extractBlocks>["records"] = []) {
    for (const a of approvals) await this.requestApproval({ agentId: agent.id, ...a, runId });
    for (const m of remember) {
      await this.store.memory.set({ scope: m.scope, key: m.key, value: m.value, source: agent.id });
      await this.router.log(agent.id, "memory", `${agent.name} remembered [${m.scope}] ${m.key}`, runId, { value: m.value });
    }
    for (const m of metrics) await this.recordMetric(m.venture as VentureId, m.key, m.value, agent.id, m.at, runId);
    for (const r of records) await this.upsertRecord({ venture: r.venture as VentureId, kind: r.kind, id: r.id, title: r.title, status: r.status, fields: r.fields, source: agent.id }, runId);
  }

  // ---- Needs you: the attention list ----------------------------------------------

  private async attentionList(): Promise<AttentionItem[]> { return this.store.settings.get<AttentionItem[]>("attention", []); }
  private async saveAttention(list: AttentionItem[]) { await this.store.settings.set("attention", list.slice(-500)); }

  /** Open and snoozed-but-due items, newest first. */
  async attention(includeDone = false): Promise<AttentionItem[]> {
    const now = Date.now();
    const list = (await this.attentionList()).map((i) => (i.status === "snoozed" && i.snoozedUntil && Date.parse(i.snoozedUntil) <= now ? { ...i, status: "open" as const } : i));
    return list.filter((i) => includeDone || i.status !== "done").sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  /** Raise an item; a same-titled open item is refreshed rather than duplicated. */
  async raiseAttention(a: { title: string; why: string; due?: string; venture?: string; agentId: string; source?: AttentionItem["source"] }): Promise<AttentionItem> {
    const list = await this.attentionList();
    const key = a.title.trim().toLowerCase();
    const existing = list.find((i) => i.status !== "done" && i.title.trim().toLowerCase() === key);
    if (existing) {
      existing.why = a.why || existing.why; existing.due = a.due ?? existing.due; existing.status = "open"; existing.snoozedUntil = undefined;
      await this.saveAttention(list);
      return existing;
    }
    const item: AttentionItem = { id: randomUUID(), at: new Date().toISOString(), title: a.title.trim(), why: a.why, agentId: a.agentId, venture: a.venture, due: a.due, status: "open", source: a.source };
    list.push(item);
    await this.saveAttention(list);
    await this.router.log(a.agentId, "approval", `${getAgent(a.agentId)?.name ?? a.agentId} flagged for Phil: ${item.title}`, a.source?.runId, { why: item.why, due: item.due });
    bus.emitEvent({ type: "attention", item, change: "raised" });
    await this.notify?.(`Needs you: ${item.title}`, item.why.slice(0, 200)).catch(() => undefined);
    return item;
  }

  async attentionUpdate(id: string, change: "done" | "snoozed" | "reopened", days = 3): Promise<AttentionItem | undefined> {
    const list = await this.attentionList();
    const item = list.find((i) => i.id === id);
    if (!item) return undefined;
    if (change === "done") { item.status = "done"; item.doneAt = new Date().toISOString(); }
    else if (change === "snoozed") { item.status = "snoozed"; item.snoozedUntil = new Date(Date.now() + days * 86400_000).toISOString(); }
    else { item.status = "open"; item.snoozedUntil = undefined; item.doneAt = undefined; }
    await this.saveAttention(list);
    await this.router.log("jarvis", "decision", `Phil marked "${item.title}" ${change}${change === "snoozed" ? ` for ${days} day(s)` : ""}`);
    bus.emitEvent({ type: "attention", item, change });
    return item;
  }

  /** Phil rewrites an item in place: its title, the why, or the due date (null or "" clears it). */
  async editAttention(id: string, patch: { title?: string; why?: string; due?: string | null }): Promise<AttentionItem | undefined> {
    const list = await this.attentionList();
    const item = list.find((i) => i.id === id);
    if (!item) return undefined;
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new Error("title can't be empty");
      item.title = title;
    }
    if (patch.why !== undefined) item.why = patch.why.trim();
    if (patch.due !== undefined) item.due = patch.due?.trim() || undefined;
    await this.saveAttention(list);
    await this.router.log("jarvis", "decision", `Phil edited "${item.title}"`, undefined, { attentionId: id, changed: Object.keys(patch) });
    bus.emitEvent({ type: "attention", item, change: "edited" });
    return item;
  }

  /** Short text of what's waiting, for prompts and the brief. */
  async attentionText(limit = 15): Promise<string> {
    const open = (await this.attention()).filter((i) => i.status === "open");
    if (!open.length) return "Nothing is waiting on Phil.";
    const age = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86400_000);
    return open.slice(0, limit).map((i) => `- ${i.title} (${getAgent(i.agentId)?.name ?? i.agentId}, ${age(i.at) === 0 ? "today" : `${age(i.at)}d old`}${i.due ? `, due ${i.due}` : ""}): ${i.why}`).join("\n") + (open.length > limit ? `\n- …and ${open.length - limit} more` : "");
  }

  // ---- Venture dashboards -------------------------------------------------------

  async recordMetric(venture: VentureId, key: string, value: number, source: string, at?: string, runId?: string) {
    if (!VENTURES[venture]) throw new Error(`no such venture: ${venture}`);
    const point = { id: randomUUID(), venture, key, value, at: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString(), source };
    await this.store.metrics.add(point);
    await this.router.log(source === "phil" ? "jarvis" : source, "memory", `${VENTURES[venture].short} · ${key} = ${value}${source === "phil" ? " (Phil)" : ""}`, runId, { venture, key, value });
    bus.emitEvent({ type: "venture", venture });
    return point;
  }

  async upsertRecord(r: { venture: VentureId; kind: string; id?: string; title: string; status?: string; fields?: Record<string, unknown>; source: string }, runId?: string) {
    if (!VENTURES[r.venture]) throw new Error(`no such venture: ${r.venture}`);
    const def = recordKind(r.venture, r.kind);
    if (!def) throw new Error(`${VENTURES[r.venture].label} has no record kind "${r.kind}" (has: ${VENTURE_DASH[r.venture].records.map((k) => k.kind).join(", ") || "none"})`);
    const existing = r.id ? await this.store.records.get(r.id) : undefined;
    const now = new Date().toISOString();
    const status = r.status && def.statuses.includes(r.status) ? r.status : existing?.status ?? def.statuses[0]!;
    const item = { id: existing?.id ?? r.id ?? randomUUID(), venture: r.venture, kind: r.kind, title: r.title || existing?.title || "(untitled)", status, fields: { ...(existing?.fields ?? {}), ...(r.fields ?? {}) }, source: r.source, createdAt: existing?.createdAt ?? now, updatedAt: now };
    await this.store.records.upsert(item);
    await this.router.log(r.source === "phil" ? "jarvis" : r.source, "memory", `${VENTURES[r.venture].short} · ${def.label.split(" (")[0]}: ${item.title} → ${status}${r.source === "phil" ? " (Phil)" : ""}`, runId, { venture: r.venture, kind: r.kind, id: item.id });
    bus.emitEvent({ type: "venture", venture: r.venture });
    return item;
  }

  /** Phil removes a record from a venture board. Returns it with an id that undoes the removal for a while. */
  async removeRecord(venture: VentureId, id: string): Promise<{ record: RecordItem; undoId: string } | undefined> {
    const r = await this.store.records.get(id);
    if (!r || r.venture !== venture) return undefined;
    await this.store.records.remove(id);
    await this.router.log("jarvis", "memory", `${VENTURES[venture]?.short ?? venture} · removed ${r.kind}: ${r.title} (Phil)`, undefined, { venture, kind: r.kind, id });
    const undoId = await this.toTrash({ kind: "record", label: `${r.title}`, data: r });
    bus.emitEvent({ type: "venture", venture });
    return { record: r, undoId };
  }

  /** Fix a wrong reading: Phil sets a metric point's value. */
  async editMetric(venture: VentureId, pointId: string, value: number): Promise<MetricPoint | undefined> {
    if (!Number.isFinite(value)) throw new Error("value must be a number");
    const p = await this.store.metrics.get(pointId);
    if (!p || p.venture !== venture) return undefined;
    const next = await this.store.metrics.update(pointId, { value });
    if (!next) return undefined;
    await this.router.log("jarvis", "memory", `${VENTURES[venture]?.short ?? venture} · ${p.key} corrected ${p.value} → ${value} (Phil)`, undefined, { venture, key: p.key, from: p.value, value });
    bus.emitEvent({ type: "venture", venture });
    return next;
  }

  /** Drop a wrong reading altogether; the one before becomes the latest again. Undoable for a while. */
  async deleteMetric(venture: VentureId, pointId: string): Promise<{ point: MetricPoint; undoId: string } | undefined> {
    const p = await this.store.metrics.get(pointId);
    if (!p || p.venture !== venture) return undefined;
    await this.store.metrics.remove(pointId);
    await this.router.log("jarvis", "memory", `${VENTURES[venture]?.short ?? venture} · ${p.key} reading ${p.value} removed (Phil)`, undefined, { venture, key: p.key, value: p.value });
    const undoId = await this.toTrash({ kind: "metric", label: `${p.key} reading ${p.value}`, data: p });
    bus.emitEvent({ type: "venture", venture });
    return { point: p, undoId };
  }

  /** Phil forgets a memory item. Undoable for a while. */
  async forgetMemory(scope: string, key: string): Promise<{ item: MemoryItem; undoId: string } | undefined> {
    const item = await this.store.memory.get(scope, key);
    if (!item) return undefined;
    await this.store.memory.remove(scope, key);
    await this.router.log("jarvis", "memory", `Phil forgot [${scope}] ${key}`);
    const undoId = await this.toTrash({ kind: "memory", label: `[${scope}] ${key}`, data: item });
    return { item, undoId };
  }

  // ---- Goals --------------------------------------------------------------------

  static MAX_GOALS = 12;

  private async goalList(): Promise<Goal[]> {
    const saved = await this.store.settings.get<Goal[] | null>("goals", null);
    if (saved) return saved;
    // Before goals had a home of their own, HQ kept them as JSON in memory [phil] goals: carry them over once.
    const legacy = await this.store.memory.get("phil", "goals");
    if (!legacy) return [];
    type Old = { name?: unknown; pct?: unknown; deadline?: unknown };
    let old: { primary?: Old; secondary?: Old[] };
    try { old = JSON.parse(legacy.value) as typeof old; } catch { return []; }
    if (!old || typeof old !== "object") return [];
    const rows = [old.primary ? { ...old.primary, primary: true } : undefined, ...(Array.isArray(old.secondary) ? old.secondary : []).map((g) => ({ ...g, primary: false }))];
    const list: Goal[] = rows.filter((g): g is Old & { primary: boolean } => !!g && typeof g.name === "string" && !!g.name.trim()).map((g) => ({
      id: randomUUID(), name: String(g.name).trim(), pct: clampPct(Number(g.pct)), deadline: typeof g.deadline === "string" && g.deadline ? g.deadline : undefined, primary: g.primary, updatedAt: legacy.updatedAt,
    }));
    await this.saveGoals(list, false);
    return list;
  }

  /** Keeps exactly one primary (the first marked, else the first goal), stores the list, and tells agents and screens. */
  private async saveGoals(list: Goal[], announce = true): Promise<Goal[]> {
    let seen = false;
    for (const g of list) { if (g.primary && !seen) seen = true; else g.primary = false; }
    if (!seen && list[0]) list[0].primary = true;
    const sorted = [...list.filter((g) => g.primary), ...list.filter((g) => !g.primary)];
    await this.store.settings.set("goals", sorted);
    // Agents read memory, not settings: keep a plain-words copy of the goals there.
    if (sorted.length) {
      const fmt = (g: Goal) => `${g.name} (${g.pct}% done${g.deadline ? `, deadline ${g.deadline}` : ""})`;
      const [first, ...rest] = sorted;
      await this.store.memory.set({ scope: "phil", key: "goals", value: `Primary: ${fmt(first!)}.${rest.length ? ` Also: ${rest.map(fmt).join("; ")}.` : ""}`, source: "phil" });
    } else await this.store.memory.remove("phil", "goals");
    if (announce) bus.emitEvent({ type: "goals", goals: sorted });
    return sorted;
  }

  /** Phil's goals, primary first. */
  async goals(): Promise<Goal[]> {
    const list = await this.goalList();
    return [...list.filter((g) => g.primary), ...list.filter((g) => !g.primary)];
  }

  async addGoal(g: { name: string; pct?: number; deadline?: string; primary?: boolean }): Promise<Goal> {
    const name = g.name.trim();
    if (!name) throw new Error("name can't be empty");
    const list = await this.goalList();
    if (list.length >= Jarvis.MAX_GOALS) throw new Error(`at most ${Jarvis.MAX_GOALS} goals`);
    const goal: Goal = { id: randomUUID(), name, pct: clampPct(g.pct ?? 0), deadline: g.deadline || undefined, primary: !!g.primary || list.length === 0, updatedAt: new Date().toISOString() };
    if (goal.primary) for (const x of list) x.primary = false;
    await this.saveGoals([...list, goal]);
    await this.router.log("jarvis", "memory", `Phil set a goal: ${goal.name}${goal.primary ? " (primary)" : ""}`);
    return goal;
  }

  /** Rename, move progress, set or clear the deadline, or make it the primary goal. */
  async updateGoal(id: string, patch: { name?: string; pct?: number; deadline?: string | null; primary?: true }): Promise<Goal | undefined> {
    const list = await this.goalList();
    const goal = list.find((g) => g.id === id);
    if (!goal) return undefined;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("name can't be empty");
      goal.name = name;
    }
    if (patch.pct !== undefined) goal.pct = clampPct(patch.pct);
    if (patch.deadline !== undefined) goal.deadline = patch.deadline || undefined;
    if (patch.primary) for (const g of list) g.primary = g.id === id;
    goal.updatedAt = new Date().toISOString();
    await this.saveGoals(list);
    await this.router.log("jarvis", "memory", `Phil updated goal "${goal.name}"${patch.primary ? " and made it primary" : ""}${patch.pct !== undefined ? ` (${goal.pct}%)` : ""}`);
    return goal;
  }

  /** Delete a goal; if it was primary, the next one takes over. Undoable for a while. */
  async deleteGoal(id: string): Promise<{ goal: Goal; undoId: string } | undefined> {
    const list = await this.goalList();
    const index = list.findIndex((g) => g.id === id);
    if (index < 0) return undefined;
    const [goal] = list.splice(index, 1);
    await this.saveGoals(list);
    await this.router.log("jarvis", "memory", `Phil deleted goal "${goal!.name}"`);
    const undoId = await this.toTrash({ kind: "goal", label: goal!.name, data: goal, index });
    return { goal: goal!, undoId };
  }

  // ---- Undo ---------------------------------------------------------------------

  /** How long a delete can be undone. HQ shows the Undo button for a few seconds; the server keeps it longer. */
  static UNDO_MS = 15 * 60_000;

  private async toTrash(e: Omit<TrashEntry, "id" | "at">): Promise<string> {
    const now = Date.now();
    const list = (await this.store.settings.get<TrashEntry[]>("trash", [])).filter((x) => now - Date.parse(x.at) < Jarvis.UNDO_MS);
    const entry: TrashEntry = { id: randomUUID(), at: new Date(now).toISOString(), ...e };
    await this.store.settings.set("trash", [...list, entry].slice(-50));
    return entry.id;
  }

  /** Put back something Phil deleted: a memory item, a venture record or reading, or a goal. */
  async undo(undoId: string): Promise<{ kind: TrashEntry["kind"]; label: string } | undefined> {
    const list = await this.store.settings.get<TrashEntry[]>("trash", []);
    const e = list.find((x) => x.id === undoId);
    if (!e || Date.now() - Date.parse(e.at) >= Jarvis.UNDO_MS) return undefined;
    await this.store.settings.set("trash", list.filter((x) => x.id !== undoId));
    if (e.kind === "memory") {
      const m = e.data as MemoryItem;
      await this.store.memory.set({ scope: m.scope, key: m.key, value: m.value, source: m.source });
    } else if (e.kind === "record") {
      const r = e.data as RecordItem;
      await this.store.records.upsert(r);
      bus.emitEvent({ type: "venture", venture: r.venture });
    } else if (e.kind === "metric") {
      const p = e.data as MetricPoint;
      if (!(await this.store.metrics.get(p.id))) await this.store.metrics.add(p);
      bus.emitEvent({ type: "venture", venture: p.venture });
    } else {
      const g = e.data as Goal;
      const goals = (await this.goalList()).filter((x) => x.id !== g.id);
      if (g.primary) for (const x of goals) x.primary = false;
      goals.splice(Math.min(e.index ?? goals.length, goals.length), 0, g);
      await this.saveGoals(goals);
    }
    await this.router.log("jarvis", "memory", `Phil undid deleting ${e.kind === "memory" ? "memory" : e.kind} ${e.label}`);
    return { kind: e.kind, label: e.label };
  }

  /** Everything one venture page needs. */
  async ventureDashboard(venture: VentureId) {
    const v = VENTURES[venture];
    const dash = VENTURE_DASH[venture];
    const agents = (await this.snapshot()).filter((a) => a.venture === venture || a.serves?.includes(venture));
    const ids = new Set(agents.map((a) => a.id));
    const metrics = await Promise.all(dash.metrics.map(async (m) => {
      const series = await this.store.metrics.series(venture, m.key, 60);
      const latest = series[series.length - 1];
      const prev = series.length > 1 ? series[series.length - 2] : undefined;
      return { ...m, series: series.map((p) => ({ at: p.at, value: p.value })), latest: latest?.value, latestId: latest?.id, at: latest?.at, delta: latest && prev ? latest.value - prev.value : undefined };
    }));
    const records = await Promise.all(dash.records.map(async (k) => ({ ...k, items: await this.store.records.list(venture, k.kind) })));
    const pending = (await this.store.approvals.list("pending")).filter((a) => ids.has(a.agentId));
    const activity = (await this.store.activity.list({ limit: 300 })).filter((e) => ids.has(e.agentId)).slice(0, 25);
    return { venture: v, blurb: dash.blurb, agents, metrics, records, pending, activity };
  }

  /** One card per venture for the overview. */
  async ventureSummaries() {
    const snap = await this.snapshot();
    const pending = await this.store.approvals.list("pending");
    return Promise.all((Object.keys(VENTURES) as VentureId[]).filter((id) => id !== "root").map(async (id) => {
      const agents = snap.filter((a) => a.venture === id);
      const ids = new Set(agents.map((a) => a.id));
      const latest = await this.store.metrics.latest(id);
      const dash = VENTURE_DASH[id];
      const headline = dash.metrics.slice(0, 2).map((m) => ({ ...m, latest: latest.find((l) => l.key === m.key)?.value }));
      const counts: Record<string, number> = {};
      for (const k of dash.records) counts[k.kind] = (await this.store.records.list(id, k.kind)).length;
      const status = agents.some((a) => a.status === "error") ? "error" : agents.some((a) => a.status === "waiting") || pending.some((p) => ids.has(p.agentId)) ? "waiting" : agents.some((a) => a.status === "working") ? "working" : agents.some((a) => a.live) ? "idle" : "dormant";
      return { venture: VENTURES[id], lead: agents.find((a) => a.id === VENTURES[id].lead), agents: agents.length, live: agents.filter((a) => a.live).length, status, pending: pending.filter((p) => ids.has(p.agentId)).length, headline, counts };
    }));
  }

  /** Live text deltas for HQ while an agent is still writing. */
  private streamer(agentId: string) {
    let runId: string | undefined;
    return (delta: string) => {
      runId ??= randomUUID();
      bus.emitEvent({ type: "chat.stream", runId, agentId, delta });
    };
  }

  async say(m: Omit<ChatMessage, "id" | "at">): Promise<ChatMessage> {
    const ctx = this.convo.getStore();
    const msg: ChatMessage = { id: randomUUID(), at: new Date().toISOString(), ...(ctx && m.role !== "phil" ? { channel: ctx.channel, replyTo: ctx.replyTo } : {}), ...m };
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
        return "Commands: /brief (morning rundown), /status (who's doing what), /pause [agent|trading|all], /resume [agent|trading|all], /approvals, /waiting (what needs you), /usage, /memory, /condense (Oscar tidies memory). Talk to any agent with @name.";
      case "brief":
        return this.brief();
      case "status": {
        const s = await this.systemStatus();
        const states = await this.store.agentState.all();
        const working = states.filter((x) => x.status === "working").map((x) => x.id);
        const errors = states.filter((x) => x.status === "error").map((x) => x.id);
        const paused = states.filter((x) => x.paused).map((x) => x.id);
        const pending = (await this.store.approvals.list("pending")).length;
        const waiting = (await this.attention()).filter((i) => i.status === "open").length;
        return [`Status ${s.level.toUpperCase()}: ${s.text}.`, `${waiting} thing(s) waiting on you.`, `Working: ${working.join(", ") || "nobody"}.`, `Errors: ${errors.join(", ") || "none"}.`, `Paused: ${paused.join(", ") || "none"}${s.killSwitch.all ? " (whole web paused)" : s.killSwitch.trading ? " (trading paused)" : ""}.`, `${pending} approval(s) waiting.`].join(" ");
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
      case "waiting":
      case "todo":
        return this.attentionText(30);
      case "condense":
        return this.condenseMemory();
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
    const now = new Date();
    // Leads with data access report first (Monica's calendar, Stella's mailbox, Mantis's markets…), in parallel, time-boxed.
    const leadIds = ["monica", "stella", "mantis", "munger", "doc"];
    const reporters: AgentDef[] = [];
    for (const id of leadIds) {
      const a = getAgent(id)!;
      const cfg = await getAgentConfig(this.store, id);
      if (cfg.tools.length || (await this.store.agentState.get(id))?.lastRunAt) reporters.push(a);
    }
    const reports = (await Promise.all(reporters.map(async (a) => {
      const r = await Promise.race([
        this.runAgent(a, leadBriefTask(now), { direct: true, from: "Jarvis" }),
        new Promise<{ blocked: string; text: string }>((res) => setTimeout(() => res({ blocked: "took too long", text: "" }), Number(process.env.BRIEF_LEAD_TIMEOUT_MS ?? 180_000))),
      ]);
      return r.blocked ? null : { name: a.name, text: r.text.slice(0, 1500) };
    }))).filter((r): r is { name: string; text: string } => !!r);
    const prompt = briefPrompt({
      pending: (await this.store.approvals.list("pending")).length,
      working: states.filter((x) => x.status === "working").map((x) => x.id),
      errors: states.filter((x) => x.status === "error").map((x) => x.id),
      recent,
      reports,
      waiting: await this.attentionText(12),
    }, now);
    const memory = await this.store.memory.list();
    const r = await this.router.run(jarvis, { system: jarvisSystemPrompt(memory, (await this.systemStatus()).text, await this.attentionText()), prompt, direct: true, maxTurns: 1 });
    if (r.blocked) return `No brief: ${r.blocked}`;
    const { text, approvals, remember } = extractBlocks(r.text);
    await this.absorb(jarvis, approvals, remember, r.runId);
    const entry = { at: new Date().toISOString(), text };
    await this.store.settings.set("lastBrief", entry);
    const history = await this.store.settings.get<{ at: string; text: string }[]>("briefs", []);
    await this.store.settings.set("briefs", [entry, ...history].slice(0, 30));
    return text;
  }

  /** Oscar condenses memory; the result waits in Approvals as a record change and is applied on approval. */
  async condenseMemory(): Promise<string> {
    const oscar = getAgent("oscar")!;
    const items = await this.store.memory.list();
    if (items.length < 2) return "Nothing to condense yet.";
    const r = await this.router.run(oscar, { system: agentSystemPrompt(oscar, []), prompt: condensePrompt(items), direct: true, maxTurns: 1 });
    if (r.blocked) return `Oscar did not run: ${r.blocked}`;
    let plan: { keep?: { scope: string; key: string; value: string }[]; dropped?: number; why?: string } = {};
    const raw = r.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const first = raw.indexOf("{"), last = raw.lastIndexOf("}");
    try { plan = JSON.parse(first >= 0 ? raw.slice(first, last + 1) : raw); } catch { return "Oscar's answer wasn't a clean list; nothing changed."; }
    const keep = (plan.keep ?? []).filter((k) => k && k.key && k.value !== undefined).map((k) => ({ scope: String(k.scope || "phil"), key: String(k.key), value: String(k.value) }));
    if (!keep.length) return "Oscar wanted to drop everything; ignored.";
    const a = await this.requestApproval({ agentId: oscar.id, kind: "record", title: `Oscar: condense memory ${items.length} → ${keep.length} items`, body: `${plan.why ?? "Merged duplicates and dropped the stale."}\n\nKeeps:\n${keep.map((k) => `- [${k.scope}] ${k.key}: ${k.value}`).join("\n")}`, payload: { action: "memory.replace", keep, before: items.length, after: keep.length }, runId: r.runId });
    return a.status === "approved" ? "Memory condensed." : `Oscar's condensed memory (${items.length} → ${keep.length}) is waiting in Approvals.`;
  }

  // ---- Approvals ----------------------------------------------------------

  async requestApproval(a: Omit<Approval, "id" | "at" | "status">): Promise<Approval> {
    const payload0 = a.payload;
    if (payload0) for (const n of this.normalizers) { try { const p = await n(a.payload ?? payload0, a.agentId); if (p) a = { ...a, payload: p }; } catch { /* a connector that can't help leaves the payload as it was */ } }
    for (const pf of this.preflights) {
      const reason = await pf(a);
      if (reason) {
        const refused: Approval = { id: randomUUID(), at: new Date().toISOString(), status: "rejected", decidedAt: new Date().toISOString(), note: `refused: ${reason}`, ...a };
        await this.store.approvals.add(refused);
        await this.router.log(a.agentId, "error", `${getAgent(a.agentId)?.name ?? a.agentId}: "${a.title}" refused — ${reason}`, a.runId, { kind: a.kind });
        bus.emitEvent({ type: "approval.decided", approval: refused });
        return refused;
      }
    }
    const approval: Approval = { id: randomUUID(), at: new Date().toISOString(), status: "pending", ...a, effect: a.effect ?? this.effectOf(a) };
    await this.store.approvals.add(approval);
    // Phil's per-agent rules: low-risk kinds under the dollar cap go through on their own, logged.
    const rules = (await getAgentConfig(this.store, a.agentId)).rules;
    const pay = (a.payload ?? {}) as { amount?: unknown; max?: unknown; ids?: unknown };
    const amount = Number(pay.amount ?? 0);
    // Bulk size: an explicit max, or the number of ids. Over the agent's item cap, Phil decides.
    const items = Array.isArray(pay.ids) ? pay.ids.length : Number(pay.max ?? 0);
    const itemCap = rules.maxAutoItems ?? 100;
    const asksFor = CHARTERS[a.agentId]?.asksFor;
    const action = (a.payload as { action?: unknown } | undefined)?.action;
    // Phil's outbound rule: internal work goes through; anything reaching another person waits. Trash and money always wait.
    const auto = asksFor === "outbound"
      ? !isOutbound(a) && a.kind !== "money" && a.kind !== "strategy" && action !== "gmail.trash" && items <= itemCap
      : a.kind !== "money" && a.kind !== "strategy" && rules.autoApprove.includes(a.kind) && amount <= rules.maxAutoDollars && items <= itemCap;
    if (auto) {
      await this.router.log(a.agentId, "approval", `${getAgent(a.agentId)?.name ?? a.agentId}: "${a.title}" auto-approved by Phil's rule (${a.kind}${amount ? `, $${amount}` : ""})`, a.runId, { kind: a.kind, body: a.body });
      const done = await this.decide(approval.id, "approved", "auto: Phil's rule");
      return done ?? approval;
    }
    await this.router.setStatus(a.agentId, "waiting", `waiting on Phil: ${a.title}`);
    await this.router.log(a.agentId, "approval", `${getAgent(a.agentId)?.name ?? a.agentId} asked for approval: ${a.title}`, a.runId, { kind: a.kind, body: a.body });
    bus.emitEvent({ type: "approval.new", approval });
    await this.notify?.(`Approval: ${approval.title}`, approval.body.slice(0, 200)).catch(() => undefined);
    return approval;
  }

  async decide(id: string, decision: "approved" | "rejected" | "edited", note?: string, edits?: { body?: string; payload?: Record<string, unknown> }): Promise<Approval | undefined> {
    const before = await this.store.approvals.get(id);
    if (!before) return undefined;
    if (before.status !== "pending") return before;
    const patch: Partial<Approval> = { status: decision, decidedAt: new Date().toISOString(), note };
    if (edits?.payload) patch.payload = edits.payload;
    if (edits?.body !== undefined && edits.body !== before.body) {
      Object.assign(patch, this.applyEdit({ body: before.body, payload: patch.payload ?? before.payload }, edits.body));
      patch.original = before.original ?? before.body;
      patch.editedBy = "phil";
    }
    if (decision === "approved" && (before.original !== undefined || patch.original !== undefined)) decision = "edited";
    patch.status = decision;
    const a = await this.store.approvals.update(id, patch);
    if (!a) return undefined;
    const stillWaiting = (await this.store.approvals.list("pending")).some((p) => p.agentId === a.agentId);
    if (!stillWaiting) await this.router.setStatus(a.agentId, "idle");
    await this.router.log(a.agentId, "decision", `Phil ${decision} "${a.title}"${note ? ` — ${note}` : ""}`, a.runId, { approvalId: a.id, kind: a.kind });
    bus.emitEvent({ type: "approval.decided", approval: a });
    let outcome = "";
    if (decision !== "rejected") {
      const action = (a.payload as { action?: unknown } | undefined)?.action;
      const exec = typeof action === "string" ? this.executors.get(action) : undefined;
      if (exec) {
        try {
          outcome = (await exec(a, this)) || `Done: ${action}`;
          await this.router.log(a.agentId, "system", outcome, a.runId, { approvalId: a.id, action });
        } catch (e) {
          outcome = `Failed to execute ${action}: ${(e as Error).message}`;
          await this.router.log(a.agentId, "error", outcome, a.runId, { approvalId: a.id, action });
        }
      }
      else {
        // Nothing can act on this approval: say so plainly rather than let "approved" read as "done".
        outcome = typeof action === "string" ? `No connector handles "${action}" yet; nothing was sent or changed. Do it by hand.` : "Recorded only: no connector is attached to this, so nothing was sent or changed. Do it by hand.";
        await this.router.log(a.agentId, "system", `Approved "${a.title}" — ${outcome}`, a.runId, { approvalId: a.id, action: action ?? null });
      }
    }
    if (outcome) await this.store.approvals.update(a.id, { note: [a.note, outcome].filter(Boolean).join(" · ") });
    await this.say({ role: "system", text: `${decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Edited and approved"}: ${a.title} (${getAgent(a.agentId)?.name ?? a.agentId})${outcome ? ` — ${outcome}` : ""}` });
    return { ...a, note: outcome ? [a.note, outcome].filter(Boolean).join(" · ") : a.note };
  }

  /** Save Phil's change to the text while the item keeps waiting; the agent's original is kept. */
  async updateApproval(id: string, edits: { body: string }): Promise<Approval | undefined> {
    const a = await this.store.approvals.get(id);
    if (!a || a.status !== "pending") return a;
    const applied = this.applyEdit(a, edits.body);
    const next = await this.store.approvals.update(id, { ...applied, original: a.original ?? a.body, editedBy: "phil", effect: this.effectOf({ ...a, payload: applied.payload }) });
    if (next) bus.emitEvent({ type: "approval.updated", approval: next });
    return next;
  }

  /** Phil asks the agent about a waiting proposal; the agent answers on the card and may revise it. */
  async askAboutApproval(id: string, question: string): Promise<Approval | undefined> {
    const a = await this.store.approvals.get(id);
    if (!a || a.status !== "pending") return a;
    const agent = getAgent(a.agentId);
    if (!agent) return a;
    const thread = [...(a.thread ?? []), { at: new Date().toISOString(), from: "phil" as const, text: question }];
    await this.store.approvals.update(id, { thread });
    bus.emitEvent({ type: "approval.updated", approval: { ...a, thread } });
    const prior = (a.thread ?? []).map((m) => `${m.from === "phil" ? "Phil" : agent.name}: ${m.text}`).join("\n");
    const task = [
      `Phil has a question about a proposal of yours that is waiting for his approval. Answer it directly and briefly, in plain words, using your tools if you need to check something.`,
      `Proposal "${a.title}" (${a.kind}):\n${a.body}`,
      a.context ? `What you had seen:\n${a.context}` : "",
      a.payload ? `Payload: ${JSON.stringify(a.payload).slice(0, 3000)}` : "",
      prior ? `Earlier on this proposal:\n${prior}` : "",
      `Phil asks: ${question}`,
      `If his question means the proposal should change, put the full revised version in a fenced block tagged "revise" with JSON {"title":"...","body":"...","payload":{...},"context":"..."} (same shape as an approval block, every field complete) and say in one line what you changed. Do not queue a new approval block; the waiting one is updated in place. Never say it was sent.`,
    ].filter(Boolean).join("\n\n");
    const r = await this.runAgent(agent, task, { direct: true, from: "Phil (about a waiting approval)", noBlocks: true });
    const answerText = r.blocked ? `(${agent.name} did not run: ${r.blocked})` : r.text;
    const m = answerText.match(/```revise\s*\n([\s\S]*?)```/);
    const patch: Partial<Approval> = {};
    let answer = answerText.replace(/```revise\s*\n[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (m) {
      try {
        const o = JSON.parse(m[1]!) as { title?: unknown; body?: unknown; payload?: unknown; context?: unknown };
        if (typeof o.body === "string" && o.body.trim()) patch.body = o.body;
        if (typeof o.title === "string" && o.title.trim()) patch.title = o.title;
        if (o.payload && typeof o.payload === "object") patch.payload = o.payload as Record<string, unknown>;
        if (typeof o.context === "string" && o.context.trim()) patch.context = o.context;
        if (patch.body || patch.payload) { patch.original = a.original ?? a.body; patch.editedBy = a.editedBy === "phil" ? "phil" : "agent"; patch.effect = this.effectOf({ ...a, payload: patch.payload ?? a.payload }); }
        answer = answer || "Revised as above.";
      } catch { answer += "\n\n(The revision could not be read; the proposal is unchanged.)"; }
    }
    const current = await this.store.approvals.get(id);
    if (!current || current.status !== "pending") return current;
    const next = await this.store.approvals.update(id, { ...patch, thread: [...(current.thread ?? []), { at: new Date().toISOString(), from: "agent", text: answer || "(no answer)" }] });
    await this.router.log(agent.id, "approval", `${agent.name} answered Phil on "${a.title}"${m ? " and revised it" : ""}`, r.runId, { approvalId: id, question });
    if (next) bus.emitEvent({ type: "approval.updated", approval: next });
    return next;
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
      const model = st?.modelOverride || a.model;
      return { ...a, live: a.phase <= phase, model, status: st?.paused ? "paused" : (st?.status ?? "idle"), lastRunAt: st?.lastRunAt, lastError: st?.lastError, detail: st?.detail };
    });
  }
}
