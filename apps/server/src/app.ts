import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { ACTIVITY_KINDS, AGENTS, VENTURES, MODELS, SCHEDULES, VENTURE_DASH, findAgent, getAgentConfig, limitsSchema, setAgentConfig, usageSummary, type ActivityEntry, type GoogleConnector, type Jarvis, type TradingGuard, type VentureId, type XConnector, type SpotifyConnector, type KuberaConnector, type GoHighLevelConnector, type DiscordConnector, type GithubConnector, type RobinhoodConnector, CHARTERS, healthKey, healthKeyOk, healthStatus, healthSummary, ingestHealth, rotateHealthKey, imageExists, imageMimeOk, loadImage, saveImage, MAX_IMAGE_BYTES, memoryLine, scheduleView, withCustom, runRoutine, recentReports, backupStatus, addDataFile, listDataFiles, removeDataFile, listDecks, deckFile, loadFile, getTemplate, setTemplate, clearTemplate, MAX_FILE_BYTES, VENTURE_IDS, removeFile } from "@jarvis/core";
import { passkeyRoutes } from "./passkeys.js";
import { ttsRoutes } from "./tts.js";
import { authEnabled, isAuthed, login, logout, requireAuth } from "./auth.js";

export function createApp(jarvis: Jarvis, connectors: { google?: GoogleConnector; x?: XConnector; spotify?: SpotifyConnector; kubera?: KuberaConnector; ghl?: GoHighLevelConnector; discord?: DiscordConnector; github?: GithubConnector; robinhood?: RobinhoodConnector; guard?: TradingGuard } = {}) {
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
  // Apple Health from Phil's iPhone (Health Auto Export). Its own key, not the HQ login, since the app can't sign in.
  app.post("/api/apple-health/ingest", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const given = auth.replace(/^Bearer\s+/i, "") || c.req.header("x-api-key") || c.req.query("key");
    if (!(await healthKeyOk(jarvis.store, given))) return c.json({ error: "bad or missing key" }, 401);
    const body = await c.req.json().catch(() => null);
    try {
      const r = await ingestHealth(jarvis.store, body);
      await jarvis.router.log("doc", "system", `Apple Health synced: ${r.samples} readings and ${r.workouts} workouts${r.days.length ? ` for ${r.days[0]}${r.days.length > 1 ? ` to ${r.days[r.days.length - 1]}` : ""}` : ""}`);
      return c.json({ ok: true, ...r });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.route("/api/tts", ttsRoutes().use("*", requireAuth));

  const api = new Hono();
  api.use("*", requireAuth);

  api.get("/state", async (c) => {
    const [agents, status, pending, usage, providers] = await Promise.all([
      jarvis.snapshot(), jarvis.systemStatus(), jarvis.store.approvals.list("pending"), usageSummary(jarvis.store), jarvis.router.providerStatus(),
    ]);
    const waiting = (await jarvis.attention()).filter((i) => i.status === "open").length;
    return c.json({ agents, ventures: VENTURES, models: MODELS, status, pendingApprovals: pending.length, waiting, usage, providers, schedules: SCHEDULES });
  });

  api.get("/chat", async (c) => c.json({ messages: await jarvis.store.chat.list(Number(c.req.query("limit") ?? 100)) }));
  api.post("/chat", async (c) => {
    const parsed = z.object({ text: z.string().max(8000), wait: z.boolean().optional(), channel: z.enum(["hq", "telegram", "voice", "schedule"]).optional(), images: z.array(z.string().max(80)).max(4).optional() })
      .refine((b) => b.text.trim().length > 0 || (b.images?.length ?? 0) > 0)
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "text required (up to 8000 characters), or an image" }, 400);
    for (const id of parsed.data.images ?? []) if (!(await imageExists(id))) return c.json({ error: "image not found; upload it first" }, 400);
    const { message, done } = await jarvis.submit(parsed.data.text, { channel: parsed.data.channel ?? "hq", images: parsed.data.images });
    if (parsed.data.wait) return c.json({ messages: await done, replyTo: message.id });
    // Replies stream in over the websocket as chat.message events with replyTo = this message's id.
    return c.json({ messages: [message], replyTo: message.id, pending: true });
  });

  // Images Phil attaches: the raw image in the body (JPEG, PNG, WebP or GIF, up to 5 MB), an id back.
  api.post("/uploads", async (c) => {
    const type = c.req.header("content-type") ?? "";
    if (!imageMimeOk(type.split(";")[0]!.trim().toLowerCase())) return c.json({ error: "only JPEG, PNG, WebP or GIF images" }, 415);
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return c.json({ error: "image is over 5 MB" }, 413);
    try { return c.json({ id: await saveImage(buf, type) }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  api.get("/uploads/:id", async (c) => {
    const f = await loadImage(c.req.param("id"));
    if (!f) return c.json({ error: "not found" }, 404);
    return new Response(new Uint8Array(f.data), { headers: { "content-type": f.mime, "cache-control": "private, max-age=86400" } });
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
  // Save a change to the text while the item keeps waiting (nothing is sent).
  api.put("/approvals/:id", async (c) => {
    const body = z.object({ body: z.string().min(1).max(20000) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "body required" }, 400);
    const a = await jarvis.updateApproval(c.req.param("id"), body.data);
    if (!a) return c.json({ error: "not found" }, 404);
    return c.json({ approval: a });
  });
  // Ask the agent about its proposal; the answer lands on the card and may revise it.
  api.post("/approvals/:id/ask", async (c) => {
    const body = z.object({ question: z.string().min(1).max(4000) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "question required" }, 400);
    const a = await jarvis.askAboutApproval(c.req.param("id"), body.data.question);
    if (!a) return c.json({ error: "not found" }, 404);
    return c.json({ approval: a });
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

  // ---- Needs you ---------------------------------------------------------------
  api.get("/attention", async (c) => c.json({ items: await jarvis.attention(c.req.query("all") === "1") }));
  api.post("/attention", async (c) => {
    const p = z.object({ title: z.string().min(1).max(160), why: z.string().max(600).default(""), due: z.string().optional(), venture: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "title required" }, 400);
    return c.json({ item: await jarvis.raiseAttention({ ...p.data, agentId: "jarvis" }) });
  });
  // Phil rewrites an item in place. due: "YYYY-MM-DD", or "" / null to clear it.
  api.put("/attention/:id", async (c) => {
    const p = z.object({
      title: z.string().trim().min(1).max(160).optional(),
      why: z.string().max(600).optional(),
      due: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due must be YYYY-MM-DD"), z.literal(""), z.null()]).optional(),
    }).strict().refine((v) => Object.keys(v).length > 0, "nothing to change").safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "bad body" }, 400);
    const item = await jarvis.editAttention(c.req.param("id"), p.data);
    return item ? c.json({ item }) : c.json({ error: "not found" }, 404);
  });
  api.post("/attention/:id/:change", async (c) => {
    const change = c.req.param("change");
    if (!["done", "snoozed", "reopened"].includes(change)) return c.json({ error: "change must be done, snoozed or reopened" }, 400);
    const p = z.object({ days: z.number().int().min(1).max(60).optional() }).safeParse(await c.req.json().catch(() => ({})));
    const item = await jarvis.attentionUpdate(c.req.param("id"), change as "done" | "snoozed" | "reopened", p.success ? p.data.days : undefined);
    return item ? c.json({ item }) : c.json({ error: "not found" }, 404);
  });

  api.get("/activity", async (c) => {
    // ?exclude=run hides the per-run lines so the log shows what actually happened.
    const exclude = (c.req.query("exclude") ?? "").split(",").filter((k): k is ActivityEntry["kind"] => (ACTIVITY_KINDS as readonly string[]).includes(k));
    return c.json({ entries: await jarvis.store.activity.list({ q: c.req.query("q") || undefined, agentId: c.req.query("agent") || undefined, limit: Number(c.req.query("limit") ?? 200), exclude: exclude.length ? exclude : undefined }) });
  });
  api.get("/runs/:id", async (c) => { const r = await jarvis.store.runs.get(c.req.param("id")); return r ? c.json({ run: r }) : c.json({ error: "not found" }, 404); });

  api.get("/usage", async (c) => c.json(await usageSummary(jarvis.store)));

  api.get("/memory", async (c) => c.json({ items: await jarvis.store.memory.list(c.req.query("scope") || undefined) }));
  api.put("/memory", async (c) => {
    const p = z.object({ scope: z.string().min(1), key: z.string().min(1), value: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "scope, key, value required" }, 400);
    await jarvis.store.memory.set({ ...p.data, source: "phil" });
    await jarvis.router.log("jarvis", "memory", memoryLine("Phil", p.data.scope, p.data.key), undefined, { scope: p.data.scope, key: p.data.key });
    return c.json({ ok: true });
  });
  api.post("/memory/condense", async (c) => c.json({ message: await jarvis.condenseMemory() }));
  api.delete("/memory", async (c) => {
    const scope = c.req.query("scope"), key = c.req.query("key");
    if (!scope || !key) return c.json({ error: "scope and key required" }, 400);
    const r = await jarvis.forgetMemory(scope, key);
    return r ? c.json({ ok: true, undoId: r.undoId }) : c.json({ error: "not found" }, 404);
  });

  // ---- Goals -------------------------------------------------------------------
  const goalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "deadline must be YYYY-MM-DD");
  api.get("/goals", async (c) => c.json({ goals: await jarvis.goals() }));
  api.post("/goals", async (c) => {
    const p = z.object({ name: z.string().trim().min(1).max(160), pct: z.number().min(0).max(100).optional(), deadline: z.union([goalDate, z.literal("")]).optional(), primary: z.boolean().optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "name required" }, 400);
    try { return c.json({ goal: await jarvis.addGoal(p.data), goals: await jarvis.goals() }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  api.put("/goals/:id", async (c) => {
    const p = z.object({ name: z.string().trim().min(1).max(160).optional(), pct: z.number().min(0).max(100).optional(), deadline: z.union([goalDate, z.literal(""), z.null()]).optional(), primary: z.literal(true).optional(),
      benchmarks: z.array(z.object({ text: z.string().trim().min(1).max(200), weight: z.number().min(1).max(100).optional(), done: z.boolean().optional() })).max(12).optional(),
      benchmarksDone: z.object({ done: z.array(z.string().max(200)).max(12).optional(), undone: z.array(z.string().max(200)).max(12).optional() }).optional() })
      .strict().refine((v) => Object.keys(v).length > 0, "nothing to change").safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "bad body" }, 400);
    const goal = await jarvis.updateGoal(c.req.param("id"), p.data);
    return goal ? c.json({ goal, goals: await jarvis.goals() }) : c.json({ error: "not found" }, 404);
  });
  api.delete("/goals/:id", async (c) => {
    const r = await jarvis.deleteGoal(c.req.param("id"));
    return r ? c.json({ goal: r.goal, undoId: r.undoId, goals: await jarvis.goals() }) : c.json({ error: "not found" }, 404);
  });

  // Put back something just deleted (memory item, venture record or reading, goal).
  api.post("/undo/:id", async (c) => {
    const r = await jarvis.undo(c.req.param("id"));
    return r ? c.json({ restored: r }) : c.json({ error: "nothing to undo (it may have expired)" }, 404);
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
    return c.json({ config: await getAgentConfig(jarvis.store, agent.id), tools: [...new Set([...jarvis.allTools().map((t) => t.name), ...Object.values(CHARTERS).flatMap((ch) => ch.tools ?? [])])], defaultModel: agent.model, charter: CHARTERS[agent.id] ?? null });
  });
  api.put("/agents/:id/config", async (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    const str = z.string().max(2000).optional();
    const p = z.object({
      persona: z.object({ reportsTo: str, job: str, daily: str, tools: str, alone: str, approval: str, preferredAI: str, good: str }).partial().optional(),
      model: z.enum(Object.keys(MODELS) as [string, ...string[]]).nullable().optional(),
      schedule: z.object({ enabled: z.boolean(), when: z.string().regex(/^(daily@([01]\d|2[0-3]):[0-5]\d|weekdays@([01]\d|2[0-3]):[0-5]\d|weekly:(sun|mon|tue|wed|thu|fri|sat)@([01]\d|2[0-3]):[0-5]\d|monthly:([1-9]|1\d|2[0-8])@([01]\d|2[0-3]):[0-5]\d|every:(?!0+$)\d{1,4}|)$/, "use daily@HH:MM, weekdays@HH:MM, weekly:<day>@HH:MM, monthly:<1-28>@HH:MM or every:<minutes> (at least 1)"), task: z.string().max(2000) }).nullable().optional(),
      rules: z.object({ autoApprove: z.array(z.enum(["send", "post", "money", "strategy", "config", "record", "other"])), maxAutoDollars: z.number().min(0).max(1_000_000), maxAutoItems: z.number().int().min(0).max(100_000) }).partial().optional(),
      tools: z.array(z.string()).optional(),
      accounts: z.array(z.string().email()).optional(),
    }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "bad body", issues: p.error.issues }, 400);
    // A tool from a connector that isn't connected yet (Gmail, X) is still a real tool: keep it, it switches on when
    // the connector does. Only names nothing in HQ knows are refused.
    const known = new Set([...jarvis.allTools().map((t) => t.name), ...Object.values(CHARTERS).flatMap((ch) => ch.tools ?? [])]);
    const unknown = p.data.tools?.filter((t) => !known.has(t)) ?? [];
    if (unknown.length) return c.json({ error: `unknown tool: ${unknown.join(", ")}` }, 400);
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
  // Fix a wrong reading, or drop it (undoable).
  api.put("/ventures/:id/metrics/:pointId", async (c) => {
    const v = ventureId(c.req.param("id"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    const p = z.object({ value: z.number().finite() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "numeric value required" }, 400);
    const point = await jarvis.editMetric(v, c.req.param("pointId"), p.data.value);
    return point ? c.json({ point }) : c.json({ error: "not found" }, 404);
  });
  api.delete("/ventures/:id/metrics/:pointId", async (c) => {
    const v = ventureId(c.req.param("id"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    const r = await jarvis.deleteMetric(v, c.req.param("pointId"));
    return r ? c.json({ point: r.point, undoId: r.undoId }) : c.json({ error: "not found" }, 404);
  });
  api.delete("/ventures/:id/records/:rid", async (c) => {
    const v = ventureId(c.req.param("id"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    const r = await jarvis.removeRecord(v, c.req.param("rid"));
    return r ? c.json({ ok: true, undoId: r.undoId }) : c.json({ error: "not found" }, 404);
  });

  // ---- Connectors -----------------------------------------------------------
  const oauthStates = new Set<string>();
  api.get("/connectors", async (c) => c.json({
    google: connectors.google ? { configured: true, ...(await connectors.google.status()) } : { configured: false, connected: false, accounts: [] },
    x: connectors.x ? { configured: true, ...(await connectors.x.status()) } : { configured: false, accounts: [] },
    spotify: connectors.spotify ? { configured: true, ...(await connectors.spotify.status()) } : { configured: false, connected: false },
    kubera: connectors.kubera ? await connectors.kubera.status() : { configured: false },
    ghl: connectors.ghl ? await connectors.ghl.status() : { configured: false },
    discord: connectors.discord ? await connectors.discord.status() : { configured: false },
    github: connectors.github ? await connectors.github.status() : { configured: false },
    robinhood: connectors.robinhood ? await connectors.robinhood.status() : { configured: false, connected: false },
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
  api.get("/connectors/spotify/auth", (c) => {
    if (!connectors.spotify) return c.json({ error: "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET aren't set" }, 400);
    return c.json({ url: connectors.spotify.authUrl().url });
  });
  api.get("/connectors/spotify/callback", async (c) => {
    const { code, state, error } = c.req.query();
    if (!connectors.spotify) return c.text("Spotify connector not configured", 400);
    if (error) return c.redirect(`/settings?spotify=${encodeURIComponent(error)}`);
    if (!code || !state) return c.text("missing code or state", 400);
    try {
      const t = await connectors.spotify.exchangeCode(code, state);
      await jarvis.router.log("jarvis", "system", `Phil connected Spotify${t.name ? ` (${t.name})` : ""}`);
      return c.redirect("/settings?spotify=connected");
    } catch (e) {
      return c.redirect(`/settings?spotify=${encodeURIComponent((e as Error).message)}`);
    }
  });
  api.post("/connectors/spotify/disconnect", async (c) => {
    await connectors.spotify?.disconnect();
    await jarvis.router.log("jarvis", "system", "Phil disconnected Spotify");
    return c.json({ ok: true });
  });
  api.get("/connectors/robinhood/auth", async (c) => {
    if (!connectors.robinhood) return c.json({ error: "Robinhood connector not configured" }, 400);
    try { return c.json({ url: (await connectors.robinhood.authUrl()).url }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  api.get("/connectors/robinhood/callback", async (c) => {
    const { code, state, error } = c.req.query();
    if (!connectors.robinhood) return c.text("Robinhood connector not configured", 400);
    if (error) return c.redirect(`/settings?robinhood=${encodeURIComponent(error)}`);
    if (!code || !state) return c.text("missing code or state", 400);
    try {
      await connectors.robinhood.exchangeCode(code, state);
      await jarvis.router.log("jarvis", "system", "Phil connected Robinhood");
      return c.redirect("/settings?robinhood=connected");
    } catch (e) { return c.redirect(`/settings?robinhood=${encodeURIComponent((e as Error).message)}`); }
  });
  api.post("/connectors/robinhood/disconnect", async (c) => {
    await connectors.robinhood?.disconnect();
    await jarvis.router.log("jarvis", "system", "Phil disconnected Robinhood");
    return c.json({ ok: true });
  });
  api.post("/connectors/robinhood/test", async (c) => {
    if (!connectors.robinhood) return c.json({ error: "Robinhood connector not configured" }, 400);
    try { return c.json({ ok: true, summary: await connectors.robinhood.check() }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  api.post("/connectors/discord/test", async (c) => {
    if (!connectors.discord) return c.json({ error: "DISCORD_BOT_TOKEN and DISCORD_CHANNELS aren't set" }, 400);
    try { return c.json({ ok: true, summary: await connectors.discord.check() }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  api.post("/connectors/github/test", async (c) => {
    if (!connectors.github) return c.json({ error: "GITHUB_READ_TOKEN isn't set" }, 400);
    try { return c.json({ ok: true, summary: await connectors.github.check() }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  api.post("/connectors/ghl/test", async (c) => {
    if (!connectors.ghl) return c.json({ error: "GHL_API_KEY and GHL_LOCATION_ID aren't set" }, 400);
    try { return c.json({ ok: true, summary: `${await connectors.ghl.check()}\n${await connectors.ghl.conversationsText(await connectors.ghl.conversations(true, 5), true)}` }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  // Check the Kubera key works (one call, cached for 20 minutes) and show the net worth line.
  api.post("/connectors/kubera/test", async (c) => {
    if (!connectors.kubera) return c.json({ error: "KUBERA_API_KEY and KUBERA_SECRET aren't set" }, 400);
    try { return c.json({ ok: true, summary: await connectors.kubera.summary() }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  // Backups: the last run, and run one now.
  api.get("/backup", async (c) => c.json({ last: await backupStatus(jarvis.store), dir: process.env.BACKUP_DIR ?? "/var/backups/jarvis", drive: !!connectors.google, healthcheck: !!process.env.HEALTHCHECK_URL }));
  api.post("/backup", async (c) => {
    const fn = jarvis.tasks.get("backup");
    if (!fn) return c.json({ error: "backups aren't set up on this server" }, 400);
    const line = await fn();
    await jarvis.router.log("jarvis", "system", `Phil ran a backup: ${line}`);
    return c.json({ result: line, last: await backupStatus(jarvis.store) });
  });
  // What came up the chain: every routine report and hand-over of the last few days, for the Reports screen.
  api.get("/reports", async (c) => c.json({ reports: await recentReports(jarvis.store, Math.min(168, Math.max(1, Number(c.req.query("hours") ?? 72)))) }));
  // Every routine in the web (built-in and each agent's own), for the Schedules screen and agent pages.
  api.get("/schedules", async (c) => {
    const agent = c.req.query("agent");
    const all = await scheduleView(jarvis.store);
    return c.json({ schedules: agent ? all.filter((s) => s.agentId === agent) : all, phase: await jarvis.store.settings.get("phase", 0) });
  });
  // Run one routine now (for example Stevon's deck before the Monday timer). It runs in the background; the answer
  // lands in chat and, for routines that report, on Telegram.
  api.post("/schedules/:id/run", async (c) => {
    const s = (await withCustom(jarvis.store)).find((x) => x.id === c.req.param("id"));
    if (!s || s.task === "brief" || s.task === "condense") return c.json({ error: "no such routine" }, 404);
    void runRoutine(jarvis, s, { direct: true }).catch((e) => jarvis.router.log(s.agentId, "error", `Routine ${s.id} failed: ${(e as Error).message}`));
    return c.json({ started: true });
  });

  // Data Phil uploads for a venture (ProEdge's weekly sales), its presentation template, and the decks made from them.
  const venture = (v: string) => (VENTURE_IDS as readonly string[]).includes(v) && v !== "root" ? v : undefined;
  const rawUpload = async (c: { req: { arrayBuffer(): Promise<ArrayBuffer>; header(n: string): string | undefined; query(n: string): string | undefined } }) => {
    const data = Buffer.from(await c.req.arrayBuffer());
    if (data.length > MAX_FILE_BYTES) throw new Error("file is over 20 MB");
    return { data, name: (c.req.query("name") ?? "upload").replace(/[\\/\r\n]+/g, " ").slice(0, 160), mime: c.req.header("content-type") ?? "", note: c.req.query("note") ?? undefined };
  };
  api.get("/data/:venture", async (c) => {
    const v = venture(c.req.param("venture"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    const files = (await listDataFiles(jarvis.store, v)).map(({ text: _t, ...f }) => f);
    const tpl = await getTemplate(jarvis.store, v);
    return c.json({ files, decks: (await listDecks(jarvis.store, v)).slice(0, 20), template: tpl ? { name: tpl.name, at: tpl.at, slides: tpl.outline.length, fileId: tpl.fileId } : null });
  });
  api.post("/data/:venture/files", async (c) => {
    const v = venture(c.req.param("venture"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    try { const f = await addDataFile(jarvis.store, v, await rawUpload(c)); const { text: _t, ...rest } = f; return c.json({ file: rest }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  api.delete("/data/:venture/files/:id", async (c) => {
    const v = venture(c.req.param("venture"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    return (await removeDataFile(jarvis.store, v, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
  api.post("/data/:venture/template", async (c) => {
    const v = venture(c.req.param("venture"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    try { const u = await rawUpload(c); const t = await setTemplate(jarvis.store, v, u.name, u.data); return c.json({ template: { name: t.name, at: t.at, slides: t.outline.length, fileId: t.fileId } }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  api.delete("/data/:venture/template", async (c) => {
    const v = venture(c.req.param("venture"));
    if (!v) return c.json({ error: "no such venture" }, 404);
    await clearTemplate(jarvis.store, v);
    return c.json({ ok: true });
  });
  // Download a deck (by deck id) or a stored file (by file id).
  api.get("/files/:id", async (c) => {
    const id = c.req.param("id");
    const d = await deckFile(jarvis.store, id);
    const f = d ?? (await loadFile(id).then((x) => (x ? { name: id, ...x } : undefined)));
    if (!f) return c.json({ error: "not found" }, 404);
    const ascii = f.name.replace(/[^\x20-\x7e]+/g, "_").replace(/"/g, "'");
    return new Response(new Uint8Array(f.data), { headers: { "content-type": f.mime, "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`, "cache-control": "private, max-age=3600" } });
  });

  // The picture shown when the home screen's display is off (Phil's own; Joi's skyline until he sets one).
  api.get("/display", async (c) => c.json({ background: await jarvis.store.settings.get<string | null>("display.background", null) }));
  api.post("/display/background", async (c) => {
    const type = c.req.header("content-type") ?? "";
    if (!imageMimeOk(type.split(";")[0]!.trim().toLowerCase())) return c.json({ error: "send a JPEG, PNG or WebP image" }, 415);
    try {
      const id = await saveImage(Buffer.from(await c.req.arrayBuffer()), type, MAX_FILE_BYTES);
      const old = await jarvis.store.settings.get<string | null>("display.background", null);
      await jarvis.store.settings.set("display.background", id);
      if (old) await removeFile(old);
      return c.json({ background: id });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  api.delete("/display/background", async (c) => {
    const old = await jarvis.store.settings.get<string | null>("display.background", null);
    await jarvis.store.settings.set("display.background", null);
    if (old) await removeFile(old);
    return c.json({ background: null });
  });

  api.get("/apple-health", async (c) => c.json({ ...(await healthStatus(jarvis.store)), summary: await healthSummary(jarvis.store, 3) }));
  // Make the key (or a new one, which stops the old one working) and show how to set up the app.
  api.post("/apple-health/key", async (c) => {
    const rotate = (await c.req.json().catch(() => ({})) as { rotate?: boolean }).rotate === true;
    const key = rotate ? await rotateHealthKey(jarvis.store) : (await healthKey(jarvis.store, true))!;
    if (rotate) await jarvis.router.log("jarvis", "system", "Phil made a new Apple Health key; the old one no longer works");
    return c.json({ key });
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
