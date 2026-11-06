import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store/types.js";
import { defineTool, type ToolDef } from "../tools/index.js";
import type { Describer, Executor } from "../jarvis/orchestrator.js";

/**
 * Robinhood's official agent access (the Trading MCP server, public beta since May 2026) for Buffett and Munger.
 * Phil connects it once from Settings: HQ registers itself as a client, sends him to Robinhood to sign in (PKCE, no
 * secret), and keeps the tokens. Then HQ speaks MCP over HTTP to agent.robinhood.com.
 * Reading (positions, balances, orders, market data) is free for the agents. Anything that places or cancels an order
 * is an approval for Phil first (kind "money"), and Robinhood only lets an agent trade inside the dedicated Agentic
 * account anyway, with the funds Phil puts there.
 *   ROBINHOOD_MCP_URL   optional, default https://agent.robinhood.com/mcp/trading
 */
export interface RobinhoodOptions { mcpUrl?: string; redirectUri: string; fetch?: typeof fetch; now?: () => number }
interface Meta { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; scopes_supported?: string[] }
interface Client { client_id: string; redirect_uri: string }
interface Tokens { access_token: string; refresh_token?: string; expires_at?: number; connectedAt: string; scope?: string }
export interface McpTool { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } }
type Rpc = { jsonrpc: "2.0"; id?: number; result?: unknown; error?: { code: number; message: string } };

const CLIENT_KEY = "robinhood.client";
const TOKENS_KEY = "robinhood.tokens";
const STATUS_KEY = "robinhood.status";
const DEFAULT_URL = "https://agent.robinhood.com/mcp/trading";
/** Without an annotation, only a tool that plainly reads is treated as a read; anything else waits for Phil. */
const READ = /^(get|list|search|quote|quotes|lookup|fetch|read|history|show|describe|view|find|check)[_-]?/i;
const b64url = (b: Buffer) => b.toString("base64url");

export class RobinhoodConnector {
  readonly id = "robinhood";
  private f: typeof fetch;
  private now: () => number;
  private url: string;
  private pending = new Map<string, string>(); // state -> PKCE verifier
  private meta?: Meta;
  private session?: string;
  private rpcId = 1;
  private toolsCache?: { at: number; tools: McpTool[] };
  constructor(private store: Store, private opts: RobinhoodOptions) { this.f = opts.fetch ?? fetch; this.now = opts.now ?? (() => Date.now()); this.url = opts.mcpUrl ?? DEFAULT_URL; }

  static fromEnv(store: Store): RobinhoodConnector {
    const origin = (process.env.HQ_ORIGIN ?? "http://localhost:3000").split(",")[0]!.trim();
    return new RobinhoodConnector(store, { mcpUrl: process.env.ROBINHOOD_MCP_URL, redirectUri: `${origin}/api/connectors/robinhood/callback` });
  }

  // ---- OAuth -------------------------------------------------------------------------------------

  private async discover(): Promise<Meta> {
    if (this.meta) return this.meta;
    const base = new URL(this.url);
    // The path-aware form first (what the MCP spec says), then the plain one (what Robinhood serves today).
    for (const u of [`${base.origin}/.well-known/oauth-authorization-server${base.pathname}`, `${base.origin}/.well-known/oauth-authorization-server`]) {
      const res = await this.f(u).catch(() => undefined);
      if (res?.ok) { const j = (await res.json().catch(() => null)) as Meta | null; if (j?.authorization_endpoint && j.token_endpoint) { this.meta = j; return j; } }
    }
    throw new Error("Robinhood's sign-in details aren't available right now");
  }

  private async client(): Promise<Client> {
    const saved = await this.store.settings.get<Client | null>(CLIENT_KEY, null);
    if (saved && saved.redirect_uri === this.opts.redirectUri) return saved;
    const meta = await this.discover();
    if (!meta.registration_endpoint) throw new Error("Robinhood doesn't offer client registration");
    const res = await this.f(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Jarvis HQ", redirect_uris: [this.opts.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
    if (!res.ok) throw new Error(`Robinhood refused to register HQ (${res.status})`);
    const j = (await res.json()) as { client_id: string };
    const c = { client_id: j.client_id, redirect_uri: this.opts.redirectUri };
    await this.store.settings.set(CLIENT_KEY, c);
    return c;
  }

  async authUrl(): Promise<{ url: string; state: string }> {
    const meta = await this.discover();
    const c = await this.client();
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    this.pending.set(state, verifier);
    const u = new URL(meta.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", c.client_id);
    u.searchParams.set("redirect_uri", c.redirect_uri);
    u.searchParams.set("scope", (meta.scopes_supported ?? ["internal"]).join(" "));
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("resource", this.url);
    return { url: u.toString(), state };
  }

  async exchangeCode(code: string, state: string): Promise<Tokens> {
    const verifier = this.pending.get(state);
    if (!verifier) throw new Error("unknown sign-in state; start again from Settings");
    this.pending.delete(state);
    const c = await this.client();
    const t = await this.token({ grant_type: "authorization_code", code, redirect_uri: c.redirect_uri, client_id: c.client_id, code_verifier: verifier, resource: this.url });
    this.session = undefined; this.toolsCache = undefined;
    return t;
  }

  private async token(form: Record<string, string>): Promise<Tokens> {
    const meta = await this.discover();
    const res = await this.f(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form) });
    if (!res.ok) throw new Error(`Robinhood sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    const prev = await this.store.settings.get<Tokens | null>(TOKENS_KEY, null);
    const t: Tokens = { access_token: j.access_token, refresh_token: j.refresh_token ?? prev?.refresh_token, expires_at: j.expires_in ? this.now() + j.expires_in * 1000 : undefined, connectedAt: prev?.connectedAt ?? new Date(this.now()).toISOString(), scope: j.scope };
    await this.store.settings.set(TOKENS_KEY, t);
    return t;
  }

  private async accessToken(force = false): Promise<string> {
    const t = await this.store.settings.get<Tokens | null>(TOKENS_KEY, null);
    if (!t) throw new Error("Robinhood isn't connected. Phil connects it in Settings.");
    if (force || (t.expires_at && this.now() > t.expires_at - 60_000)) {
      if (!t.refresh_token) throw new Error("Robinhood's sign-in expired; reconnect it in Settings.");
      const c = await this.client();
      return (await this.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.client_id, resource: this.url })).access_token;
    }
    return t.access_token;
  }

  async disconnect() { await this.store.settings.set(TOKENS_KEY, null); this.session = undefined; this.toolsCache = undefined; }
  async status() {
    const t = await this.store.settings.get<Tokens | null>(TOKENS_KEY, null);
    return { configured: true, connected: !!t, connectedAt: t?.connectedAt, lastFetch: await this.store.settings.get<{ ok: boolean; at: string; error?: string } | null>(STATUS_KEY, null) };
  }

  // ---- MCP over HTTP ------------------------------------------------------------------------------

  private async rpc<T>(method: string, params?: unknown, retry = true, fresh = false): Promise<T> {
    const id = this.rpcId++;
    const token = await this.accessToken(fresh);
    const res = await this.f(this.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(this.session ? { "mcp-session-id": this.session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) });
    if (res.status === 401) {
      // One refresh and retry before giving up (the token may have expired without an expires_in to warn us).
      if (!fresh && (await this.store.settings.get<Tokens | null>(TOKENS_KEY, null))?.refresh_token) return this.rpc(method, params, retry, true);
      await this.mark(false, "Robinhood refused the token"); throw new Error("Robinhood refused HQ's sign-in; reconnect it in Settings.");
    }
    if (res.status === 404 && this.session && retry) { this.session = undefined; return this.rpc(method, params, false); } // session expired
    if (!res.ok) { await this.mark(false, `Robinhood error ${res.status}`); throw new Error(`Robinhood error ${res.status}: ${(await res.text()).slice(0, 200)}`); }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    const text = await res.text();
    const msg = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? sseResult(text, id) : (JSON.parse(text || "{}") as Rpc);
    if (!msg) throw new Error("Robinhood sent no answer");
    if (msg.error) throw new Error(`Robinhood: ${msg.error.message}`);
    await this.mark(true);
    return msg.result as T;
  }

  private async ensureSession() {
    if (this.session) return;
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Jarvis HQ", version: "0.1" } });
    // The initialized notification has no id and expects no reply.
    const token = await this.accessToken();
    await this.f(this.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(this.session ? { "mcp-session-id": this.session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).catch(() => undefined);
  }

  private async mark(ok: boolean, error?: string) { await this.store.settings.set(STATUS_KEY, { ok, at: new Date(this.now()).toISOString(), error }); }

  async listTools(): Promise<McpTool[]> {
    if (this.toolsCache && this.now() - this.toolsCache.at < 10 * 60_000) return this.toolsCache.tools;
    await this.ensureSession();
    const r = await this.rpc<{ tools: McpTool[] }>("tools/list", {});
    this.toolsCache = { at: this.now(), tools: r.tools ?? [] };
    return this.toolsCache.tools;
  }

  isWrite(t: McpTool): boolean {
    if (t.annotations?.readOnlyHint === true) return false;
    if (t.annotations && t.annotations.readOnlyHint === false) return true;
    return !READ.test(t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    await this.ensureSession();
    const r = await this.rpc<{ content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown }>("tools/call", { name, arguments: args });
    const text = (r.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`)).join("\n").trim() || (r.structuredContent ? JSON.stringify(r.structuredContent) : "(no content)");
    if (r.isError) throw new Error(text.slice(0, 400));
    return text.length > 12_000 ? `${text.slice(0, 12_000)}\n… (cut)` : text;
  }

  async check(): Promise<string> {
    const tools = await this.listTools();
    const reads = tools.filter((t) => !this.isWrite(t)).length;
    return `Connected. Robinhood offers ${tools.length} tools: ${reads} read-only, ${tools.length - reads} that change something (those always wait for your approval).`;
  }

  // ---- For agents ----------------------------------------------------------------------------------

  tools(): ToolDef[] {
    const wrap = (fn: () => Promise<string>) => fn().catch((e: Error) => `Robinhood: ${e.message}`);
    return [
      defineTool({ name: "robinhood_tools", description: "What Phil's Robinhood connection can do: every tool name with what it takes, marked read or write. Call this first to learn the exact tool and argument names.", schema: {}, handler: () => wrap(async () => { const ts = await this.listTools(); return ts.length ? ts.map((t) => `${this.isWrite(t) ? "WRITE (approval) " : "read "}${t.name}: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 220)}${t.inputSchema ? ` · args ${JSON.stringify(t.inputSchema).slice(0, 300)}` : ""}`).join("\n") : "Robinhood listed no tools."; }) }),
      defineTool({ name: "robinhood_read", description: "Read from Phil's Robinhood through one of its read-only tools (positions, balances, orders, history, quotes, market data): the tool name from robinhood_tools and its arguments as JSON. Tools that change anything are refused here; those go in a money approval with action robinhood.call.", schema: { tool: z.string().min(1).max(80), args: z.record(z.string(), z.unknown()).optional() }, handler: (a) => wrap(async () => { const t = (await this.listTools()).find((x) => x.name === a.tool); if (!t) return `Robinhood has no tool called ${a.tool}; call robinhood_tools.`; if (this.isWrite(t)) return `${a.tool} changes something, so it isn't a read. Put it in an approval block: {"kind":"money","title":"...","body":"what and why","payload":{"action":"robinhood.call","tool":"${a.tool}","args":{...}}}.`; return this.call(a.tool, a.args ?? {}); }) }),
    ];
  }

  /** Writes (orders, cancels): only after Phil approves. */
  executors(): Record<string, Executor> {
    return {
      "robinhood.call": async (a) => {
        const p = (a.payload ?? {}) as { tool?: unknown; args?: unknown };
        if (typeof p.tool !== "string" || !p.tool) throw new Error("robinhood.call needs the tool name (from robinhood_tools)");
        const args = p.args && typeof p.args === "object" ? (p.args as Record<string, unknown>) : {};
        return `Robinhood ${p.tool}: ${(await this.call(p.tool, args)).slice(0, 1500)}`;
      },
    };
  }

  describe(): Record<string, Describer> {
    return { "robinhood.call": (p) => `Runs Robinhood's ${String(p.tool ?? "?")} with ${JSON.stringify(p.args ?? {}).slice(0, 300)}. If it's an order, it's placed in your Robinhood Agentic account the moment you approve, with real money from that account.` };
  }

  static promptHint(): string {
    return "Robinhood is connected (its official agent access). robinhood_tools lists what it offers; robinhood_read runs any read-only tool (positions, balances, orders, quotes, history) by name with JSON args. Anything that places, changes or cancels an order is never run directly: put it in an approval block, kind \"money\", payload {\"action\":\"robinhood.call\",\"tool\":\"<name>\",\"args\":{...}}, with the reasoning in body. Robinhood only lets agents trade in Phil's dedicated Agentic account.";
  }
}

/** The matching JSON-RPC response out of a server-sent-events body. */
export function sseResult(text: string, id: number): Rpc | undefined {
  let last: Rpc | undefined;
  for (const block of text.split(/\n\n+/)) {
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data) continue;
    try { const j = JSON.parse(data) as Rpc; if (j.id === id) return j; if (j.result !== undefined || j.error) last = j; } catch { /* keep going */ }
  }
  return last;
}
