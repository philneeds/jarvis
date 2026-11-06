import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { bus, type Approval, type AttentionItem, type ChatMessage, type Goal, type Benchmark, type SystemStatus } from "../events.js";
import { AGENTS, CHARTERS, findAgent, getAgent, type AgentDef } from "../registry/index.js";
import { ModelRouter } from "../router/index.js";
import type { MemoryItem, MetricPoint, RecordItem, Store } from "../store/types.js";
import { usageSummary } from "../usage/caps.js";
import { extractBlocks, parsePlan } from "./blocks.js";
import { agentSystemPrompt, briefPrompt, condensePrompt, dayStart, jarvisSystemPrompt, leadBriefTask, planPrompt, synthesisPrompt } from "./prompts.js";
import { memoryLine } from "./readable.js";
import { getAgentConfig } from "../config.js";
import { VENTURES, type VentureId } from "../registry/ventures.js";
import { VENTURE_DASH, recordKind } from "../ventures/dashboards.js";
import { TOOLS } from "../tools/index.js";
import { imageInputs } from "../uploads.js";
import { HEALTH_TOOLS } from "../health.js";
import { XREAD_TOOLS, expandXLinks, xPostIds } from "../xread.js";
import { DATA_TOOLS, recentDataImages } from "../salesdata.js";
import { HYPERLIQUID_TOOLS } from "../hyperliquid.js";
import { LOOKUP_TOOLS } from "../lookup.js";
import { DECK_HINT, makeDeck, normalizeDeck, type Deck } from "../decks.js";

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
  const p = (a.payload ?? {}) as { action?: unknown; attendees?: unknown; guests?: unknown; public?: unknown };
  if (a.kind === "send" || a.kind === "post") return true;
  if (p.public === true) return true;
  if (typeof p.action === "string" && OUTBOUND_ACTIONS.has(p.action)) return true;
  if (Array.isArray(p.attendees) && p.attendees.length) return true;
  if (Array.isArray(p.guests) && p.guests.length) return true;
  // An action no connector recognises is treated as outbound: when unsure, ask.
  return typeof p.action !== "string" || !/^(gmail\.(archive|label|trash)|calendar\.(create|update|delete)|spotify\.playlist\.(create|add)|goals\.(update|benchmarks)|watchlist\.add|memory\.replace|record\.)/.test(p.action);
}

/** Something Phil deleted, kept for a while so he can undo it. */
interface TrashEntry { id: string; at: string; kind: "memory" | "record" | "metric" | "goal"; label: string; data: unknown; index?: number }

const clampPct = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);

/** Which payload field holds the text Phil edits on the card, per action. */
const TEXT_FIELD: Record<string, string> = { "gmail.send": "body", "x.post": "text", "x.reply": "text", "x.dm": "text", "ghl.message": "message" };

export class Jarvis {
  readonly store: Store;
  readonly router: ModelRouter;
  private notify?: JarvisOptions["notify"];
  private executors = new Map<string, Executor>();
  /** Plain words for what an action does with a given payload; shown to Phil before he approves. */
  private describers = new Map<string, Describer>();
  /** Extra tools from connectors, by name. */
  readonly connectorTools = new Map<string, import("../tools/index.js").ToolDef>();
  /** Housekeeping the scheduler runs by name (the server registers "backup"); each returns a one-line result for the log. */
  readonly tasks = new Map<string, () => Promise<string>>();
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
    // Phil's goals for the month, as agreed with Adam: add the new ones, retire the finished or dropped ones.
    this.executors.set("goals.set", async (a) => {
      const p = (a.payload ?? {}) as { add?: { name?: unknown; deadline?: unknown; pct?: unknown; primary?: unknown }[]; retire?: unknown[] };
      const current = await this.goals();
      const retiring = (p.retire ?? []).map(String).filter((id) => current.some((g) => g.id === id)).length;
      const adding = (p.add ?? []).filter((g) => typeof g.name === "string" && g.name.trim()).length;
      if (current.length - retiring + adding > Jarvis.MAX_GOALS) throw new Error(`that would leave ${current.length - retiring + adding} goals; at most ${Jarvis.MAX_GOALS}. Retire more first.`);
      const retired: string[] = [];
      for (const id of (p.retire ?? []).map(String)) { const r = await this.deleteGoal(id); if (r) retired.push(r.goal.name); }
      const added: string[] = [];
      for (const g of p.add ?? []) {
        if (typeof g.name !== "string" || !g.name.trim()) continue;
        const deadline = typeof g.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(g.deadline) ? g.deadline : undefined;
        await this.addGoal({ name: g.name, deadline, pct: typeof g.pct === "number" ? g.pct : 0, primary: g.primary === true });
        added.push(g.name.trim());
      }
      if (!added.length && !retired.length) throw new Error("the proposal had no goals to add or retire");
      // David's job: benchmarks for every new goal, so the bar moves on evidence. In the background, after this approval.
      const david = getAgent("david");
      if (added.length && david) setTimeout(() => { void this.runAgent(david, `New goals were just set: ${added.join("; ")}. Call goals_list and set benchmarks for each new goal (goals.benchmarks): the 3 to 6 concrete, checkable things that, done, mean the goal is reached, weighted by how much each moves it.`, { from: "Jarvis" }).then((r) => (r.blocked ? undefined : this.say({ role: "agent", agentId: david.id, text: r.text, runId: r.runId }))).catch(() => undefined); }, 0);
      return `Goals set${added.length ? `: ${added.join("; ")}` : ""}${retired.length ? `. Retired: ${retired.join("; ")}` : ""}.`;
    });
    // David keeps percent-done honest: an internal change, so it goes through and is reported in chat.
    this.executors.set("goals.update", async (a) => {
      const p = (a.payload ?? {}) as { id?: unknown; pct?: unknown; done?: unknown; undone?: unknown };
      if (typeof p.id !== "string") throw new Error("goals.update needs the goal id (goals_list)");
      const pct = p.pct === undefined ? undefined : Number(p.pct);
      const done = Array.isArray(p.done) ? p.done.map(String) : [];
      const undone = Array.isArray(p.undone) ? p.undone.map(String) : [];
      if (!done.length && !undone.length && (pct === undefined || !Number.isFinite(pct))) throw new Error("goals.update needs benchmarks to tick (done) or a pct from 0 to 100");
      const g = await this.updateGoal(p.id, { ...(pct !== undefined && Number.isFinite(pct) ? { pct } : {}), ...(done.length || undone.length ? { benchmarksDone: { done, undone } } : {}) }, a.agentId);
      if (!g) throw new Error("no goal with that id; check goals_list");
      return `"${g.name}" is now ${g.pct}% done${done.length ? ` (${done.length} benchmark${done.length > 1 ? "s" : ""} met)` : ""}.`;
    });
    // David's benchmarks for a goal: what moves its bar, each weighted.
    this.executors.set("goals.benchmarks", async (a) => {
      const p = (a.payload ?? {}) as { id?: unknown; benchmarks?: unknown };
      if (typeof p.id !== "string" || !Array.isArray(p.benchmarks)) throw new Error("goals.benchmarks needs the goal id and a list of benchmarks");
      const list = (p.benchmarks as { text?: unknown; weight?: unknown; done?: unknown }[]).filter((b) => b && typeof b.text === "string" && b.text.trim()).map((b) => ({ text: String(b.text), weight: Number(b.weight), done: b.done === true }));
      if (!list.length) throw new Error("no benchmarks in the proposal");
      const g = await this.updateGoal(p.id, { benchmarks: list }, a.agentId);
      if (!g) throw new Error("no goal with that id; check goals_list");
      return `"${g.name}" has ${g.benchmarks?.length ?? 0} benchmarks; it's ${g.pct}% done.`;
    });
    this.describers.set("goals.benchmarks", (p) => `Sets ${Array.isArray(p.benchmarks) ? p.benchmarks.length : "the"} benchmarks for a goal on your home screen; ticking them moves its bar. Nothing leaves HQ.`);
    // A scout's own idea for the stock watchlist, added once Phil approves.
    this.executors.set("watchlist.add", async (a) => {
      const p = (a.payload ?? {}) as { symbol?: unknown; sector?: unknown; thesis?: unknown };
      const symbol = String(p.symbol ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) throw new Error("watchlist.add needs a ticker symbol");
      await this.upsertRecord({ venture: "money", kind: "holding", title: symbol, status: "watch", fields: { sector: String(p.sector ?? ""), thesis: String(p.thesis ?? a.body ?? "").slice(0, 300) }, source: a.agentId }, a.runId);
      return `${symbol} is on the watchlist.`;
    });
    this.describers.set("watchlist.add", (p) => `Adds ${String(p.symbol ?? "").toUpperCase()} to your stock watchlist on the Money board. Nothing is bought.`);
    this.describers.set("goals.update", (p) => Array.isArray(p.done) && p.done.length ? `Ticks ${p.done.length} benchmark${p.done.length > 1 ? "s" : ""} on a goal, which moves its bar on your home screen. Nothing leaves HQ.` : `Sets a goal's progress to ${Number(p.pct)}% on your home screen. Nothing leaves HQ.`);
    this.describers.set("goals.set", (p) => {
      const add = (Array.isArray(p.add) ? p.add : []) as { name?: string; primary?: boolean; deadline?: string }[];
      const retire = Array.isArray(p.retire) ? p.retire.length : 0;
      return `Sets your goals on the home screen: ${add.map((g) => `${g.name}${g.primary ? " (primary)" : ""}${g.deadline ? `, by ${g.deadline}` : ""}`).join("; ") || "none new"}${retire ? `, and retires ${retire} old goal(s)` : ""}. Nothing leaves HQ.`;
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
  allTools() { return [...TOOLS, ...HEALTH_TOOLS, ...XREAD_TOOLS, ...DATA_TOOLS, ...HYPERLIQUID_TOOLS, ...LOOKUP_TOOLS, ...this.connectorTools.values()]; }

  // ---- Chat -------------------------------------------------------------

  /** The conversation a reply belongs to, carried through async work so every say() in it is tagged. */
  private convo = new AsyncLocalStorage<{ channel: ChatMessage["channel"]; replyTo: string; images?: string[] }>();

  /**
   * Submit a message from Phil and return at once with his message; the work continues in the background and
   * every reply (ack, progress, final) arrives as a chat.message event tagged with replyTo = his message id.
   */
  async submit(text: string, opts: { channel?: ChatMessage["channel"]; images?: string[] } = {}): Promise<{ message: ChatMessage; done: Promise<ChatMessage[]> }> {
    const images = opts.images?.slice(0, 4);
    // A picture on its own is a question too.
    const trimmed = text.trim() || (images?.length ? "What do you think of this?" : "");
    if (!trimmed) throw new Error("empty message");
    const message = await this.say({ role: "phil", text: trimmed, channel: opts.channel ?? "hq", ...(images?.length ? { images } : {}) });
    const ctx = { channel: opts.channel ?? "hq", replyTo: message.id, images };
    const done = this.convo.run(ctx, async () => {
      // X links: open the posts first, so whoever takes this sees what they say (and their photos).
      let work = trimmed;
      if (!trimmed.startsWith("/") && xPostIds(trimmed).length) {
        const x = await expandXLinks(trimmed).catch(() => ({ context: "", imageIds: [] as string[] }));
        if (x.context) work = `${trimmed}\n\n${x.context}`;
        if (x.imageIds.length) ctx.images = [...(ctx.images ?? []), ...x.imageIds].slice(0, 4);
        if (x.context) await this.router.log("jarvis", "system", `Opened ${xPostIds(trimmed).length} X post(s) Phil linked`);
      }
      return this.handleStored(work);
    }).catch(async (e) => [await this.say({ role: "jarvis", text: `Something broke on my side: ${(e as Error).message}`, kind: "final" })]);
    return { message, done };
  }

  /** Handle one message from Phil and wait for everything. Returns the replies (already stored and broadcast). */
  async handle(text: string, opts: { channel?: ChatMessage["channel"]; images?: string[] } = {}): Promise<ChatMessage[]> {
    const trimmed = text.trim();
    if (!trimmed && !opts.images?.length) return [];
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
    const { recentReports, reportsText } = await import("../scheduler.js");
    const system = jarvisSystemPrompt(memory, status.text, await this.attentionText(), reportsText(await recentReports(this.store, 48)));

    const imageIds = this.convo.getStore()?.images ?? [];
    const planText = imageIds.length ? `${userText}\n\n(Phil attached ${imageIds.length} image${imageIds.length > 1 ? "s" : ""}. Anything about how something looks goes to Joi; the image goes with the task.)` : userText;
    const planRun = await this.router.run(jarvis, { system, prompt: planPrompt(planText, recent), direct: true, maxTurns: 1, images: await imageInputs(imageIds) });
    if (planRun.blocked) {
      out.push(await this.say({ role: "jarvis", text: `I can't think right now: ${planRun.blocked}`, kind: "final" }));
      return out;
    }
    const plan = parsePlan(planRun.text);
    const seen = new Set<string>();
    const delegations = plan.delegate
      .map((d) => ({ ...d, agent: getAgent(d.agent) ?? findAgent(d.agent) }))
      .filter((d): d is { agent: AgentDef; task: string } => !!d.agent && d.agent.id !== "jarvis" && !seen.has(d.agent.id) && !!seen.add(d.agent.id))
      .slice(0, 4);

    if (!delegations.length) {
      const { text, approvals, remember, attention } = extractBlocks(plan.reply ?? planRun.text);
      await this.absorb(jarvis, approvals, remember, planRun.runId);
      // "Add X to my to-do list": Jarvis puts it on Phil's list himself.
      for (const a of attention) await this.raiseAttention({ ...a, agentId: "jarvis", source: { runId: planRun.runId } });
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
    const system = agentSystemPrompt(agent, memory, cfg.persona, tools) + (tools.some((t) => this.connectorTools.has(t.name)) && this.promptHints.length ? `\n\n${this.promptHints.join("\n")}` : "") + (cfg.tools.includes("deck_template") ? `\n\n${DECK_HINT}` : "");
    const prompt = `${opts.from ?? "Phil"} asks: ${task}`;
    // Images Phil attached to this conversation go with every run in it, including hand-offs; agents that read uploaded
    // data also see this week's screenshots.
    const dataImages = cfg.tools.includes("sales_data") ? await recentDataImages(this.store, agent.venture) : [];
    const images = await imageInputs([...(this.convo.getStore()?.images ?? []), ...dataImages]);
    const r = await this.router.run(agent, { system, prompt, direct: opts.direct, parentRunId: opts.parentRunId, tools, toolContext: { store: this.store, agentId: agent.id }, onDelta: this.streamer(agent.id), images });
    if (r.blocked) return r;
    if (opts.noBlocks) return r; // the caller reads the reply itself (approval Q&A)
    const { text: said, approvals, remember, metrics, records, handoffs, attention, slides } = extractBlocks(r.text);
    let text = said;
    await this.absorb(agent, approvals, remember, r.runId, metrics, records);
    // Decks: build the .pptx and hand it over in chat (and on Telegram when that's where the conversation is).
    const decks: Deck[] = [];
    for (const raw of slides.slice(0, 2)) {
      const spec = normalizeDeck(raw);
      if (!spec) { text += "\n\n(A deck was written but couldn't be read, so no file was made.)"; continue; }
      try {
        const d = await makeDeck(this.store, spec, { agentId: agent.id, venture: agent.venture });
        decks.push(d);
        await this.router.log(agent.id, "system", `${agent.name} made a deck: ${d.title} (${d.slides} slides)`, r.runId);
        await this.say({ role: "agent", agentId: agent.id, text: `Deck ready: ${d.title} · ${d.slides} slides`, runId: r.runId, files: [{ id: d.id, name: d.name }], kind: "progress" });
      } catch (e) { text += `\n\n(The deck couldn't be built: ${(e as Error).message})`; }
    }
    if (decks.length) text = `${text}\n\n[Deck ready: ${decks.map((d) => d.title).join("; ")}]`.trim();
    for (const a of attention) await this.raiseAttention({ ...a, agentId: agent.id, source: { runId: r.runId } });
    // Hand-offs: something that isn't this agent's job goes to the agent whose job it is; the receiver may hand back once.
    if (handoffs.length && (opts.depth ?? 0) < 2) {
      for (const h of handoffs.slice(0, 6)) {
        const to = getAgent(h.agent) ?? findAgent(h.agent);
        if (!to || to.id === agent.id || to.id === "jarvis") continue;
        await this.router.log(agent.id, "delegate", `${agent.name} → ${to.name}: ${h.task.slice(0, 200)}`, r.runId);
        const hr = await this.runAgent(to, h.task, { direct: opts.direct, parentRunId: r.runId, from: agent.name, depth: (opts.depth ?? 0) + 1 });
        await this.say({ role: "agent", agentId: to.id, text: hr.blocked ? `(${to.name} did not run: ${hr.blocked})` : hr.text, runId: hr.runId, via: [agent.id], kind: "progress" });
      }
    }
    return { ...r, text, decks };
  }

  private async absorb(agent: AgentDef, approvals: ReturnType<typeof extractBlocks>["approvals"], remember: ReturnType<typeof extractBlocks>["remember"], runId?: string, metrics: ReturnType<typeof extractBlocks>["metrics"] = [], records: ReturnType<typeof extractBlocks>["records"] = []) {
    for (const a of approvals) await this.requestApproval({ agentId: agent.id, ...a, runId });
    for (const m of remember) {
      await this.store.memory.set({ scope: m.scope, key: m.key, value: m.value, source: agent.id });
      await this.router.log(agent.id, "memory", memoryLine(agent.name, m.scope, m.key, agent.id), runId, { scope: m.scope, key: m.key, value: m.value });
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
      const fmt = (g: Goal) => `${g.name} (${g.pct}% done${g.deadline ? `, deadline ${g.deadline}` : ""}${g.benchmarks?.length ? `, ${g.benchmarks.filter((b) => b.done).length} of ${g.benchmarks.length} benchmarks met` : ""})`;
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

  /**
   * Rename, move progress, set or clear the deadline, make it the primary goal, replace its benchmarks, or tick them.
   * With benchmarks, the percent is the done benchmarks' share of the total weight.
   */
  async updateGoal(id: string, patch: { name?: string; pct?: number; deadline?: string | null; primary?: true; benchmarks?: { text: string; weight?: number; done?: boolean }[]; benchmarksDone?: { done?: string[]; undone?: string[] } }, by = "phil"): Promise<Goal | undefined> {
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
    const now = new Date().toISOString();
    if (patch.benchmarks) {
      // Replacing the list keeps what was already done (matched by text).
      const was = new Map((goal.benchmarks ?? []).map((b) => [b.text.trim().toLowerCase(), b]));
      goal.benchmarks = patch.benchmarks.slice(0, 12).map((b) => {
        const text = b.text.trim().slice(0, 200), old = was.get(text.toLowerCase());
        const done = b.done ?? old?.done ?? false;
        return { id: old?.id ?? randomUUID().slice(0, 8), text, weight: Math.max(1, Math.min(100, Math.round(Number.isFinite(b.weight) ? b.weight! : 1))), done, doneAt: done ? old?.doneAt ?? now : undefined };
      });
    }
    if (patch.benchmarksDone && goal.benchmarks) {
      const hit = (key: string) => (b: Benchmark) => b.id === key || b.text.toLowerCase() === key.trim().toLowerCase();
      for (const key of patch.benchmarksDone.done ?? []) { const b = goal.benchmarks.find(hit(key)); if (b && !b.done) { b.done = true; b.doneAt = now; } }
      for (const key of patch.benchmarksDone.undone ?? []) { const b = goal.benchmarks.find(hit(key)); if (b) { b.done = false; b.doneAt = undefined; } }
    }
    if ((patch.benchmarks || patch.benchmarksDone) && goal.benchmarks?.length && patch.pct === undefined) {
      const total = goal.benchmarks.reduce((n, b) => n + b.weight, 0);
      goal.pct = clampPct((goal.benchmarks.filter((b) => b.done).reduce((n, b) => n + b.weight, 0) / total) * 100);
    }
    goal.updatedAt = now;
    await this.saveGoals(list);
    const who = by === "phil" ? "Phil" : getAgent(by)?.name ?? by;
    await this.router.log(by === "phil" ? "jarvis" : by, "memory", `${who} updated goal "${goal.name}"${patch.primary ? " and made it primary" : ""}${patch.benchmarks ? ` with ${goal.benchmarks?.length ?? 0} benchmarks` : ""}${patch.pct !== undefined || patch.benchmarksDone || patch.benchmarks ? ` (${goal.pct}%)` : ""}`);
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
    // Hand-offs, approvals, errors and changes; the per-run lines would crowd them out.
    const activity = (await this.store.activity.list({ limit: 300, exclude: ["run"] })).filter((e) => ids.has(e.agentId)).slice(0, 25);
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
        return "Commands: /brief (morning rundown), /status (who's doing what), /todo <thing> (add to your to-do list; /todo alone lists it), /pause [agent|trading|all], /resume [agent|trading|all], /approvals, /waiting (what needs you), /usage, /memory, /condense (Oscar tidies memory). Talk to any agent with @name.";
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
      case "todo":
        // "/todo <thing>" adds it to Phil's to-do list; "/todo" alone lists what's open.
        if (arg) { const item = await this.raiseAttention({ title: arg.slice(0, 160), why: "Added by Phil.", agentId: "jarvis" }); return `Added to your to-do list: ${item.title}`; }
        return this.attentionText(30);
      case "waiting":
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
    // A morning lead still working (Monica at 6:45, Stella at 6:50, Mantis at 6:55) gets up to two minutes to finish,
    // so its report goes in today's brief rather than tomorrow's.
    const morning = ["monica", "stella", "mantis", "munger", "doc"];
    for (let i = 0; i < 12; i++) {
      const working = (await this.store.agentState.all()).filter((x) => morning.includes(x.id) && x.status === "working");
      if (!working.length) break;
      await new Promise((r) => setTimeout(r, Number(process.env.BRIEF_WAIT_STEP_MS ?? 10_000)));
    }
    // Reports the leads sent up since the last brief (their routines and weekly reviews). Cleared only once the brief
    // is written, so a failed run keeps them for the retry.
    const inbox = await this.store.settings.get<{ id: string; agentId: string; scheduleId: string; at: string; text: string }[]>("reports.inbox", []);
    const queued = inbox.map((q) => ({ name: `${getAgent(q.agentId)?.name ?? q.agentId} (${q.scheduleId}, ${q.at.slice(0, 16).replace("T", " ")})`, text: q.text.slice(0, 2500) }));
    // Leads with data access check in live (Monica's calendar, Stella's mailbox, Mantis's markets…), in parallel,
    // time-boxed. A lead whose routine already reported in the last three hours isn't asked again.
    const fresh = new Set(inbox.filter((q) => now.getTime() - Date.parse(q.at) < 3 * 3_600_000).map((q) => q.agentId));
    const leadIds = morning.filter((id) => !fresh.has(id));
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
      reports: [...queued, ...reports],
      waiting: await this.attentionText(12),
    }, now);
    const memory = await this.store.memory.list();
    const r = await this.router.run(jarvis, { system: jarvisSystemPrompt(memory, (await this.systemStatus()).text, await this.attentionText()), prompt, direct: true, maxTurns: 1 });
    if (r.blocked) return `No brief: ${r.blocked}`;
    const { text, approvals, remember } = extractBlocks(r.text);
    await this.absorb(jarvis, approvals, remember, r.runId);
    // Drop exactly what was briefed; a report that landed meanwhile stays for the next one.
    if (inbox.length) { const briefed = new Set(inbox.map((q) => q.id)); const { withInbox } = await import("../scheduler.js"); await withInbox(async () => { const nowInbox = await this.store.settings.get<{ id: string }[]>("reports.inbox", []); await this.store.settings.set("reports.inbox", nowInbox.filter((q) => !briefed.has(q.id))); }); }
    const entry = { at: new Date().toISOString(), text };
    await this.store.settings.set("lastBrief", entry);
    const history = await this.store.settings.get<{ at: string; text: string }[]>("briefs", []);
    await this.store.settings.set("briefs", [entry, ...history].slice(0, 30));
    return text;
  }

  /** Oscar condenses memory; the result waits in Needs you as a record change and is applied on approval. */
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
    return a.status === "approved" ? "Memory condensed." : `Oscar's condensed memory (${items.length} → ${keep.length}) is waiting in Needs you.`;
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
    const auto = asksFor === "everything" ? false : asksFor === "outbound"
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

  /**
   * Live snapshot for the Agent Web: every agent with its status, phase and model, and `runsToday`: the agent's
   * own successful runs since midnight in Phil's time zone (one grouped count over today's "run" lines).
   */
  async snapshot(now = new Date()) {
    const [rows, phase, runs] = await Promise.all([this.store.agentState.all(), this.store.settings.get("phase", 0), this.store.activity.countSince("run", dayStart(now))]);
    const states = new Map(rows.map((s) => [s.id, s]));
    return AGENTS.map((a) => {
      const st = states.get(a.id);
      const model = st?.modelOverride || a.model;
      return { ...a, live: a.phase <= phase, model, status: st?.paused ? "paused" : (st?.status ?? "idle"), lastRunAt: st?.lastRunAt, lastError: st?.lastError, detail: st?.detail, runsToday: runs[a.id] ?? 0 };
    });
  }
}
