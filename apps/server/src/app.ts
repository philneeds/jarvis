import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { AGENTS, VENTURES, MODELS, SCHEDULES, VENTURE_DASH, findAgent, getAgentConfig, limitsSchema, setAgentConfig, usageSummary, type GoogleConnector, type Jarvis, type TradingGuard, type VentureId, type XConnector } from "@jarvis/core";
import { passkeyRoutes } from "./passkeys.js";
import { ttsRoutes } from "./tts.js";
import { authEnabled, isAuthed, login, logout, requireAuth } from "./auth.js";

export function createApp(jarvis: Jarvis, connectors: { google?: GoogleConnector; x?: XConnector; guard?: TradingGuard } = {}) {
  const app = new Hono();
  const origins = (process.env.HQ_ORIGIN ?? "http://localhost:3000").split(",").map((s) => s.trim());
  app.use("/api/*", cors({ origin: origins, credentials: true }));

  app.get("/api/health", (c) => c.json({ ok: true, auth: authEnabled, store: jarvis.store.kind }));

  app.post("/api/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ password: z.string() }).safeParse(body);
    if (!parsed.success) return c.json({ error: "password required" }, 400);
    if (!login(c, parsed.data.password)) return c.json({ error: "wrong password" }, 401);
    return c.json({ ok: true });
  });
  app.post("/api/logout", (c) => { logout(c); return c.json({ ok: true }); });
  app.get("/api/me", (c) => c.json({ authed: isAuthed(c), auth: authEnabled }));
  app.route("/api/passkeys", passkeyRoutes(jarvis.store));
  app.route("/api/tts", ttsRoutes().use("*", requireAuth));

  const api = new Hono();
  api.use("*", requireAuth);

  api.get("/state", async (c) => {
    const [agents, status, pending, usage, providers] = await Promise.all([
      jarvis.snapshot(), jarvis.systemStatus(), jarvis.store.approvals.list("pending"), usageSummary(jarvis.store), jarvis.router.providerStatus(),
    ]);
    return c.json({ agents, ventures: VENTURES, models: MODELS, status, pendingApprovals: pending.length, usage, providers, schedules: SCHEDULES });
  });

  api.get("/chat", async (c) => c.json({ messages: await jarvis.store.chat.list(Number(c.req.query("limit") ?? 100)) }));
  api.post("/chat", async (c) => {
    const parsed = z.object({ text: z.string().min(1).max(8000) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "text required" }, 400);
    const messages = await jarvis.handle(parsed.data.text);
    return c.json({ messages });
  });

  api.get("/brief", async (c) => {
    const last = await jarvis.store.settings.get<{ at: string; text: string } | null>("lastBrief", null);
    const history = await jarvis.store.settings.get<{ at: string; text: string }[]>("briefs", []);
    return c.json({ brief: last, history });
  });
  api.post("/brief", async (c) => {
    const text = await jarvis.brief();
    const m = await jarvis.say({ role: "jarvis", text: `Daily brief\n\n${text}` });
    return c.json({ message: m });
  });

  api.get("/approvals", async (c) => {
    const status = c.req.query("status") as "pending" | "approved" | "rejected" | "edited" | undefined;
    return c.json({ approvals: await jarvis.store.approvals.list(status) });
  });
  api.post("/approvals/:id/:decision", async (c) => {
    const decision = c.req.param("decision");
    if (!["approve", "reject", "edit"].includes(decision)) return c.json({ error: "decision must be approve, reject or edit" }, 400);
    const body = z.object({ note: z.string().max(2000).optional(), body: z.string().max(20000).optional(), payload: z.record(z.string(), z.unknown()).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "bad body" }, 400);
    const a = await jarvis.decide(c.req.param("id"), decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "edited", body.data.note, { body: body.data.body, payload: body.data.payload });
    if (!a) return c.json({ error: "not found" }, 404);
    return c.json({ approval: a });
  });

  api.get("/activity", async (c) => c.json({ entries: await jarvis.store.activity.list({ q: c.req.query("q") || undefined, agentId: c.req.query("agent") || undefined, limit: Number(c.req.query("limit") ?? 200) }) }));
  api.get("/runs/:id", async (c) => { const r = await jarvis.store.runs.get(c.req.param("id")); return r ? c.json({ run: r }) : c.json({ error: "not found" }, 404); });

  api.get("/usage", async (c) => c.json(await usageSummary(jarvis.store)));

  api.get("/memory", async (c) => c.json({ items: await jarvis.store.memory.list(c.req.query("scope") || undefined) }));
  api.put("/memory", async (c) => {
    const p = z.object({ scope: z.string().min(1), key: z.string().min(1), value: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "scope, key, value required" }, 400);
    await jarvis.store.memory.set({ ...p.data, source: "phil" });
    await jarvis.router.log("jarvis", "memory", `Phil set [${p.data.scope}] ${p.data.key}`);
    return c.json({ ok: true });
  });
  api.post("/memory/condense", async (c) => c.json({ message: await jarvis.condenseMemory() }));
  api.delete("/memory", async (c) => {
    await jarvis.store.memory.remove(c.req.query("scope") ?? "", c.req.query("key") ?? "");
    return c.json({ ok: true });
  });

  api.get("/agents", async (c) => c.json({ agents: await jarvis.snapshot() }));
  api.post("/agents/:id/pause", async (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    return c.json({ message: await jarvis.pause(agent.id, true) });
  });
  api.post("/agents/:id/resume", async (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    return c.json({ message: await jarvis.pause(agent.id, false) });
  });
  api.post("/agents/:id/run", async (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    const p = z.object({ task: z.string().min(1).max(8000) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "task required" }, 400);
    const r = await jarvis.runAgent(agent, p.data.task, { direct: true });
    const m = await jarvis.say({ role: "agent", agentId: agent.id, text: r.blocked ? `(${agent.name} did not run: ${r.blocked})` : r.text, runId: r.runId });
    return c.json({ message: m, blocked: r.blocked });
  });
  api.get("/agents/:id/config", async (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    return c.json({ config: await getAgentConfig(jarvis.store, agent.id), tools: jarvis.allTools().map((t) => t.name), defaultModel: agent.model });
  });
  api.put("/agents/:id/config", async (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    const str = z.string().max(2000).optional();
    const p = z.object({
      persona: z.object({ reportsTo: str, job: str, daily: str, tools: str, alone: str, approval: str, preferredAI: str, good: str }).partial().optional(),
      model: z.enum(Object.keys(MODELS) as [string, ...string[]]).nullable().optional(),
      schedule: z.object({ enabled: z.boolean(), when: z.string().regex(/^(daily@\d{2}:\d{2}|every:\d{1,4}|)$/), task: z.string().max(2000) }).nullable().optional(),
      rules: z.object({ autoApprove: z.array(z.enum(["send", "post", "money", "strategy", "config", "record", "other"])), maxAutoDollars: z.number().min(0).max(1_000_000) }).partial().optional(),
      tools: z.array(z.string()).optional(),
    }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "bad body", issues: p.error.issues }, 400);
    const known = new Set(jarvis.allTools().map((t) => t.name));
    if (p.data.tools?.some((t) => !known.has(t))) return c.json({ error: "unknown tool" }, 400);
    const config = await setAgentConfig(jarvis.store, agent.id, p.data as Parameters<typeof setAgentConfig>[2]);
    if (p.data.model !== undefined) await jarvis.store.agentState.set(agent.id, { modelOverride: p.data.model && p.data.model !== agent.model ? p.data.model : "" });
    await jarvis.router.log("jarvis", "system", `Phil updated ${agent.name}'s settings`, undefined, { changed: Object.keys(p.data) });
    return c.json({ config });
  });
  api.patch("/agents/:id", async (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    const p = z.object({ model: z.enum(Object.keys(MODELS) as [string, ...string[]]).nullable().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "bad body" }, 400);
    if (p.data.model !== undefined) {
      await jarvis.store.agentState.set(agent.id, { modelOverride: p.data.model ?? "" });
      await jarvis.router.log("jarvis", "system", `Phil set ${agent.name}'s model to ${p.data.model ?? agent.model}`);
    }
    return c.json({ ok: true });
  });

  api.post("/kill", async (c) => {
    const p = z.object({ scope: z.enum(["all", "trading"]).default("all"), paused: z.boolean().default(true) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "bad body" }, 400);
    return c.json({ message: await jarvis.pause(p.data.scope, p.data.paused), status: await jarvis.systemStatus() });
  });

  // Client-side keys and flags for the always-on device.
  api.get("/config", (c) => c.json({ wakeWordKey: process.env.PICOVOICE_ACCESS_KEY || null, tz: process.env.PHIL_TZ || "America/New_York", voice: !!process.env.ELEVENLABS_API_KEY }));
  api.get("/phase", async (c) => c.json({ phase: await jarvis.store.settings.get("phase", 0) }));
  api.post("/phase", async (c) => {
    const p = z.object({ phase: z.number().int().min(0).max(3) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "phase 0-3" }, 400);
    await jarvis.store.settings.set("phase", p.data.phase);
    await jarvis.router.log("jarvis", "system", `Phil moved the web to Phase ${p.data.phase}`);
    return c.json({ phase: p.data.phase });
  });

  api.get("/roster", (c) => c.json({ agents: AGENTS, ventures: VENTURES, models: MODELS }));

  // ---- Venture dashboards -----------------------------------------------------------
  const ventureId = (raw: string): VentureId | undefined => (raw in VENTURE_DASH && raw !== "root" ? (raw as VentureId) : undefined);
  api.get("/ventures", async (c) => c.json({ ventures: await jarvis.ventureSummaries() }));
  api.get("/ventures/:id", async (c) => {
    const v = ventureId(c.req.param("id"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    return c.json(await jarvis.ventureDashboard(v));
  });
  api.post("/ventures/:id/metrics", async (c) => {
    const v = ventureId(c.req.param("id"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    const p = z.object({ key: z.string().min(1), value: z.number().finite(), at: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "key and numeric value required" }, 400);
    if (!VENTURE_DASH[v].metrics.some((m) => m.key === p.data.key)) return c.json({ error: `unknown metric; one of ${VENTURE_DASH[v].metrics.map((m) => m.key).join(", ")}` }, 400);
    return c.json({ point: await jarvis.recordMetric(v, p.data.key, p.data.value, "phil", p.data.at) });
  });
  api.put("/ventures/:id/records", async (c) => {
    const v = ventureId(c.req.param("id"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    const p = z.object({ kind: z.string().min(1), id: z.string().optional(), title: z.string().min(1).max(300), status: z.string().optional(), fields: z.record(z.string(), z.unknown()).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "kind and title required" }, 400);
    try { return c.json({ record: await jarvis.upsertRecord({ venture: v, ...p.data, source: "phil" }) }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  api.delete("/ventures/:id/records/:rid", async (c) => {
    const v = ventureId(c.req.param("id"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    const r = await jarvis.store.records.get(c.req.param("rid"));
    if (!r || r.venture !== v) return c.json({ error: "not found" }, 404);
    await jarvis.store.records.remove(r.id);
    await jarvis.router.log("jarvis", "memory", `${VENTURES[v].short} · removed ${r.kind}: ${r.title} (Phil)`);
    return c.json({ ok: true });
  });

  // ---- Connectors -----------------------------------------------------------
  const oauthStates = new Set<string>();
  api.get("/connectors", async (c) => c.json({
    google: connectors.google ? { configured: true, ...(await connectors.google.status()) } : { configured: false, connected: false, accounts: [] },
    x: connectors.x ? { configured: true, ...(await connectors.x.status()) } : { configured: false, accounts: [] },
    telegram: { configured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) },
    ntfy: { configured: !!process.env.NOTIFY_WEBHOOK_URL },
  }));
  api.get("/connectors/google/auth", (c) => {
    if (!connectors.google) return c.json({ error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set" }, 400);
    const state = randomBytes(16).toString("base64url");
    oauthStates.add(state);
    return c.json({ url: connectors.google.authUrl(state) });
  });
  api.get("/connectors/google/callback", async (c) => {
    const { code, state, error } = c.req.query();
    if (!connectors.google) return c.text("Google connector not configured", 400);
    if (error) return c.redirect(`/settings?google=${encodeURIComponent(error)}`);
    if (!code || !state || !oauthStates.delete(state)) return c.text("bad state", 400);
    try {
      const t = await connectors.google.exchangeCode(code);
      await jarvis.router.log("jarvis", "system", `Phil connected Google${t.email ? ` (${t.email})` : ""}`);
      return c.redirect(`/settings?google=connected:${encodeURIComponent(t.email ?? "")}`);
    } catch (e) {
      return c.redirect(`/settings?google=${encodeURIComponent((e as Error).message)}`);
    }
  });
  api.post("/connectors/google/disconnect", async (c) => {
    const p = z.object({ email: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
    await connectors.google?.disconnect(p.success ? p.data.email : undefined);
    await jarvis.router.log("jarvis", "system", `Phil disconnected Google${p.success && p.data.email ? ` (${p.data.email})` : ""}`);
    return c.json({ ok: true });
  });
  api.get("/connectors/x/auth", (c) => {
    if (!connectors.x) return c.json({ error: "X_CLIENT_ID not set" }, 400);
    return c.json({ url: connectors.x.authUrl().url });
  });
  api.get("/connectors/x/callback", async (c) => {
    const { code, state, error } = c.req.query();
    if (!connectors.x) return c.text("X connector not configured", 400);
    if (error) return c.redirect(`/settings?x=${encodeURIComponent(error)}`);
    if (!code || !state) return c.text("missing code or state", 400);
    try {
      const a = await connectors.x.exchangeCode(code, state);
      await jarvis.router.log("jarvis", "system", `Phil connected X @${a.handle}`);
      return c.redirect(`/settings?x=connected:${a.handle}`);
    } catch (e) {
      return c.redirect(`/settings?x=${encodeURIComponent((e as Error).message)}`);
    }
  });
  api.post("/connectors/x/disconnect", async (c) => {
    const p = z.object({ handle: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "handle required" }, 400);
    await connectors.x?.disconnect(p.data.handle);
    await jarvis.router.log("jarvis", "system", `Phil disconnected X @${p.data.handle}`);
    return c.json({ ok: true });
  });

  // ---- Mayne's hard limits -----------------------------------------------------
  api.get("/trading", async (c) => {
    if (!connectors.guard) return c.json({ error: "no guard" }, 500);
    return c.json({ limits: await connectors.guard.limits(), ledger: await connectors.guard.ledger(), strategies: await jarvis.store.settings.get("strategies", []) });
  });
  api.put("/trading/limits", async (c) => {
    if (!connectors.guard) return c.json({ error: "no guard" }, 500);
    const p = limitsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "bad limits", issues: p.error.issues }, 400);
    const limits = await connectors.guard.setLimits(p.data);
    await jarvis.router.log("mayne", "system", `Phil set Mayne's limits: max position $${limits.maxPositionUsd}, daily loss $${limits.maxDailyLossUsd}, max open ${limits.maxOpenPositions}, auto-stop ${limits.autoStopDrawdownPct}%${limits.enabled ? "" : " (OFF)"}`);
    return c.json({ limits });
  });
  api.post("/trading/equity", async (c) => {
    if (!connectors.guard) return c.json({ error: "no guard" }, 500);
    const p = z.object({ equityUsd: z.number().min(0) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "equityUsd required" }, 400);
    const r = await connectors.guard.markEquity(p.data.equityUsd);
    if (r.stopped) await jarvis.router.log("mayne", "error", `AUTO-STOP: ${r.stopped}`);
    return c.json({ ledger: await connectors.guard.ledger(), stopped: r.stopped });
  });
  api.post("/trading/close", async (c) => {
    if (!connectors.guard) return c.json({ error: "no guard" }, 500);
    const p = z.object({ positionId: z.string().min(1), pnlUsd: z.number() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "positionId and pnlUsd required" }, 400);
    const r = await connectors.guard.close(p.data.positionId, p.data.pnlUsd);
    await jarvis.router.log("mayne", "system", `Phil closed ${p.data.positionId} at $${p.data.pnlUsd.toFixed(2)}${r.stopped ? ` — AUTO-STOP: ${r.stopped}` : ""}`);
    return c.json({ ledger: await connectors.guard.ledger(), stopped: r.stopped });
  });
  api.post("/trading/clear-stop", async (c) => {
    if (!connectors.guard) return c.json({ error: "no guard" }, 500);
    await connectors.guard.clearStop();
    await jarvis.router.log("mayne", "system", "Phil cleared Mayne's auto-stop");
    return c.json({ ledger: await connectors.guard.ledger() });
  });

  app.route("/api", api);
  return app;
}
