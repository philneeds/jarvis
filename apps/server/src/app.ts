import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { glassesKeyOk, glassesReplies, glassesStatus, pairGlasses, unpairGlasses } from "@jarvis/core";
import { kalshiLimitsText, limitsText, hlAccounts, isHlAddress, accountText, HL_ACCOUNTS_KEY, polyAccounts, polyPositionsText, POLY_ACCOUNTS_KEY, lighterAccounts, lighterAccountText, LIGHTER_ACCOUNTS_KEY } from "@jarvis/core";
import { ACTIVITY_KINDS, AGENTS, VENTURES, MODELS, SCHEDULES, VENTURE_DASH, findAgent, getAgentConfig, limitsSchema, setAgentConfig, usageSummary, type ActivityEntry, type GoogleConnector, type LeadPerfectionConnector, type Jarvis, type TradingGuard, type VentureId, type XConnector, type SpotifyConnector, type KuberaConnector, type GoHighLevelConnector, type EagleViewConnector, type DiscordConnector, type GithubConnector, type RobinhoodConnector, type Workshop, SHIP_KEY, AUTO_SHIP_KEY, CHARTERS, healthKey, healthKeyOk, healthStatus, healthSummary, ingestHealth, rotateHealthKey, imageExists, imageMimeOk, loadImage, saveImage, MAX_IMAGE_BYTES, memoryLine, scheduleView, withCustom, runRoutine, recentReports, backupStatus, phaseReadiness, type Connection, addDataFile, listDataFiles, removeDataFile, listDecks, deckFile, loadFile, getTemplate, setTemplate, clearTemplate, MAX_FILE_BYTES, VENTURE_IDS, removeFile, readDocument, saveDoc, getDocs, docsContext } from "@jarvis/core";
import { lastChecks, runChecks, saveChecks } from "@jarvis/core";
import { connectionProbes } from "./checks.js";
import { passkeyRoutes } from "./passkeys.js";
import { ttsRoutes } from "./tts.js";
import { authEnabled, clientIp, fromHq, isAuthed, login, loginFailed, loginWait, logout, requireAuth } from "./auth.js";

/** A count from the query string: a whole number from 1 to max, else the default ("abc" and -5 used to reach the store). */
const count = (raw: string | undefined, fallback: number, max: number) => { const n = Math.floor(Number(raw)); return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback; };

export function createApp(jarvis: Jarvis, connectors: { google?: GoogleConnector; x?: XConnector; spotify?: SpotifyConnector; kubera?: KuberaConnector; ghl?: GoHighLevelConnector; eagleview?: EagleViewConnector; leadperfection?: LeadPerfectionConnector; discord?: DiscordConnector; github?: GithubConnector; robinhood?: RobinhoodConnector; guard?: TradingGuard; workshop?: Workshop ; hlTrader?: import("@jarvis/core").HyperliquidTrader; kalshi?: import("@jarvis/core").KalshiTrader } = {}) {
  const app = new Hono();
  const origins = (process.env.HQ_ORIGIN ?? "http://localhost:3000").split(",").map((s) => s.trim());
  app.use("/api/*", cors({ origin: origins, credentials: true }));
  // A page on another site must not be able to act as Phil with his cookie. CORS only hides the answer; the request
  // still runs. So anything that changes state is refused when the browser says it came from somewhere else.
  app.use("/api/*", async (c, next) => {
    // The glasses app's own endpoints carry a pairing key, never the login cookie, so the cross-site check (which
    // protects the cookie) doesn't apply to them.
    if (c.req.path.startsWith("/api/glasses/device/")) return next();
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !fromHq(c.req.header("origin"), origins, c.req.header("x-forwarded-host") ?? c.req.header("host"))) return c.json({ error: "this request came from another site" }, 403);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, auth: authEnabled, store: jarvis.store.kind }));

  app.post("/api/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ password: z.string() }).safeParse(body);
    if (!parsed.success) return c.json({ error: "password required" }, 400);
    const who = clientIp(c.req.header("x-forwarded-for"));
    const wait = loginWait(who);
    if (wait) return c.json({ error: `too many wrong passwords; try again in ${Math.ceil(wait / 60_000)} minutes (a passkey still works)` }, 429);
    if (!login(c, parsed.data.password)) { loginFailed(who); return c.json({ error: "wrong password" }, 401); }
    return c.json({ ok: true });
  });
  app.post("/api/logout", (c) => { logout(c); return c.json({ ok: true }); });
  app.get("/api/me", (c) => c.json({ authed: isAuthed(c), auth: authEnabled }));
  app.route("/api/passkeys", passkeyRoutes(jarvis.store));
  // Phil's smart glasses (apps/glasses, a MentraOS miniapp on his phone). Its own pairing key, made in Settings: the
  // key can ask Jarvis something and read the replies to it, nothing else.
  const glassesAsks = new Map<string, { done: boolean; at: number }>();
  const glassesKey = async (c: { req: { header(n: string): string | undefined } }) => glassesKeyOk(jarvis.store, (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "") || undefined);
  app.get("/api/glasses/device/ping", async (c) => ((await glassesKey(c)) ? c.json({ ok: true, name: "Jarvis HQ" }) : c.json({ error: "bad or missing pairing key" }, 401)));
  app.post("/api/glasses/device/ask", async (c) => {
    if (!(await glassesKey(c))) return c.json({ error: "bad or missing pairing key" }, 401);
    const b = z.object({ text: z.string().trim().min(1).max(2000), spoken: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "text required (up to 2000 characters)" }, 400);
    const { message, done } = await jarvis.submit(b.data.text, { channel: "glasses", voice: b.data.spoken !== false });
    for (const [id, v] of glassesAsks) if (Date.now() - v.at > 60 * 60_000) glassesAsks.delete(id);
    glassesAsks.set(message.id, { done: false, at: Date.now() });
    void done.catch(() => undefined).then(() => { const e = glassesAsks.get(message.id); if (e) e.done = true; });
    return c.json({ id: message.id });
  });
  // The replies to one ask, after the first `seen` of them; waits up to `wait` seconds for something new (long poll).
  app.get("/api/glasses/device/replies", async (c) => {
    if (!(await glassesKey(c))) return c.json({ error: "bad or missing pairing key" }, 401);
    const to = c.req.query("to") ?? "", seen = Math.max(0, Number(c.req.query("seen")) || 0), wait = Math.min(Math.max(Number(c.req.query("wait")) || 0, 0), 25);
    const until = Date.now() + wait * 1000;
    for (;;) {
      const all = glassesReplies(await jarvis.store.chat.list(200), to, (id) => findAgent(id ?? "")?.name ?? id ?? "Agent");
      // An ask HQ no longer remembers (a restart) has nothing more coming.
      const finished = glassesAsks.get(to)?.done ?? true;
      if (all.length > seen || finished || Date.now() >= until) return c.json({ replies: all.slice(seen), done: finished });
      await new Promise((r) => setTimeout(r, 400));
    }
  });
  // Apple Health from Phil's iPhone (Health Auto Export). Its own key, not the HQ login, since the app can't sign in.
  app.post("/api/apple-health/ingest", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const given = auth.replace(/^Bearer\s+/i, "") || c.req.header("x-api-key") || c.req.query("key");
    if (!(await healthKeyOk(jarvis.store, given))) return c.json({ error: "bad or missing key" }, 401);
    const body = await c.req.json().catch(() => null);
    try {
      const r = await ingestHealth(jarvis.store, body);
      await jarvis.router.log("metro", "system", `Apple Health synced: ${r.samples} readings and ${r.workouts} workouts${r.days.length ? ` for ${r.days[0]}${r.days.length > 1 ? ` to ${r.days[r.days.length - 1]}` : ""}` : ""}`);
      return c.json({ ok: true, ...r });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  // The guard is registered before the routes: Hono runs handlers in the order they were added, so adding it after
  // (as this did) left text-to-speech and transcription open to anyone, on Phil's ElevenLabs key.
  const tts = new Hono();
  tts.use("*", requireAuth);
  tts.route("/", ttsRoutes());
  app.route("/api/tts", tts);

  const api = new Hono();
  api.use("*", requireAuth);

  api.get("/state", async (c) => {
    const [agents, status, pending, usage, providers] = await Promise.all([
      jarvis.snapshot(), jarvis.systemStatus(), jarvis.store.approvals.list("pending"), usageSummary(jarvis.store), jarvis.router.providerStatus(),
    ]);
    const waiting = (await jarvis.attention()).filter((i) => i.status === "open").length;
    return c.json({ agents, ventures: VENTURES, models: MODELS, status, pendingApprovals: pending.length, waiting, usage, providers, schedules: SCHEDULES });
  });

  api.get("/chat", async (c) => c.json({ messages: await jarvis.store.chat.list(count(c.req.query("limit"), 100, 500)) }));
  api.post("/chat", async (c) => {
    const parsed = z.object({ text: z.string().max(8000), wait: z.boolean().optional(), channel: z.enum(["hq", "telegram", "voice", "schedule"]).optional(), images: z.array(z.string().max(80)).max(4).optional(), docs: z.array(z.string().max(80)).max(5).optional() })
      .refine((b) => b.text.trim().length > 0 || (b.images?.length ?? 0) > 0 || (b.docs?.length ?? 0) > 0)
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "text required (up to 8000 characters), or an image or file" }, 400);
    for (const id of parsed.data.images ?? []) if (!(await imageExists(id))) return c.json({ error: "image not found; upload it first" }, 400);
    // Files Phil attached: already read into text by POST /docs; the text goes to whoever answers, the files show on his message.
    const found = await getDocs(jarvis.store, parsed.data.docs ?? []);
    if (found.some((d) => !d)) return c.json({ error: "file not found; attach it again" }, 400);
    const docs = found.filter((d) => !!d);
    const images = [...(parsed.data.images ?? []), ...docs.filter((d) => d.imageId).map((d) => d.imageId!)].slice(0, 4);
    const files = docs.filter((d) => d.fileId).map((d) => ({ id: d.fileId!, name: d.name }));
    const context = docsContext(docs) || undefined;
    const { message, done } = await jarvis.submit(parsed.data.text, { channel: parsed.data.channel ?? "hq", images, ...(files.length ? { files } : {}), ...(context ? { context } : {}) });
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
  // Files Phil attaches to a message (PDF, Word, Excel, CSV, PowerPoint, text, or an image): the raw file in the body,
  // ?name= its file name. Read into text now, so a file HQ can't read is refused before he hits send.
  api.post("/docs", async (c) => {
    const data = Buffer.from(await c.req.arrayBuffer());
    if (data.length > MAX_FILE_BYTES) return c.json({ error: "file is over 20 MB" }, 413);
    try {
      const d = await saveDoc(jarvis.store, await readDocument({ name: c.req.query("name") ?? "file", mime: c.req.header("content-type") ?? "", data }));
      return c.json({ doc: { id: d.id, name: d.name, kind: d.kind, type: d.type, pages: d.pages, rows: d.rows, slides: d.slides, chars: d.text?.length, imageId: d.imageId } });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
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
  // Talk a to-do over with one of the agents on it; the answer arrives as an "attention" event.
  api.get("/attention/:id/agents", async (c) => {
    const item = (await jarvis.attention(true)).find((i) => i.id === c.req.param("id"));
    return item ? c.json({ agents: jarvis.taskAgents(item) }) : c.json({ error: "not found" }, 404);
  });
  api.post("/attention/:id/ask", async (c) => {
    const p = z.object({ question: z.string().trim().min(1).max(4000), agentId: z.string().max(40).optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "question required" }, 400);
    const item = await jarvis.askAboutAttention(c.req.param("id"), p.data.question, p.data.agentId);
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
    return c.json({ entries: await jarvis.store.activity.list({ q: c.req.query("q") || undefined, agentId: c.req.query("agent") || undefined, limit: count(c.req.query("limit"), 200, 1000), exclude: exclude.length ? exclude : undefined }) });
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

  // Which connections work right now: the setup quests and the phase readiness card both ask this.
  const connectedNow = async (): Promise<Set<Connection>> => {
    const connected = new Set<Connection>();
    if (connectors.google && (await connectors.google.status()).connected) connected.add("Google");
    if (connectors.x && (await connectors.x.status()).accounts.length) connected.add("X");
    if (connectors.spotify && (await connectors.spotify.status()).connected) connected.add("Spotify");
    if (connectors.kubera) connected.add("Kubera");
    if (connectors.robinhood && (await connectors.robinhood.status()).connected) connected.add("Robinhood");
    // A key GoHighLevel refused isn't a connection; it counts again after the next call that succeeds.
    if (connectors.ghl && !/refused the key/.test((await connectors.ghl.status()).lastFetch?.error ?? "")) connected.add("GoHighLevel");
    if (connectors.eagleview && !/refused the credentials/.test((await connectors.eagleview.status()).lastFetch?.error ?? "")) connected.add("EagleView");
    if (connectors.leadperfection && !/refused the login/.test((await connectors.leadperfection.status()).lastFetch?.error ?? "")) connected.add("LeadPerfection");
    if (connectors.discord) connected.add("Discord");
    if (connectors.github) connected.add("GitHub");
    if (process.env.XAI_API_KEY) connected.add("X search");
    if ((await healthStatus(jarvis.store)).days > 0) connected.add("Apple Health");
    return connected;
  };
  jarvis.connectionProbe = connectedNow;

  // ---- Goals -------------------------------------------------------------------
  const goalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "deadline must be YYYY-MM-DD");
  const goalHorizon = z.enum(["long", "mid", "short"]);
  const goalVenture = z.enum(VENTURE_IDS.filter((v) => v !== "root") as [string, ...string[]]);
  api.get("/goals", async (c) => c.json({ goals: await jarvis.goals() }));
  api.post("/goals", async (c) => {
    const p = z.object({ name: z.string().trim().min(1).max(160), pct: z.number().min(0).max(100).optional(), deadline: z.union([goalDate, z.literal("")]).optional(), primary: z.boolean().optional(), horizon: goalHorizon.optional(), venture: goalVenture.optional(), parent: z.string().max(64).optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "name required" }, 400);
    try { return c.json({ goal: await jarvis.addGoal(p.data), goals: await jarvis.goals() }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  // A benchmark's rule against live data: HQ ticks it itself. The shape is checked here so a typo can't be saved.
  const checkOp = z.enum([">=", "<="]);
  const checkDays = z.number().int().min(2).max(400).optional();
  const goalCheck = z.union([
    z.object({ kind: z.literal("kubera_networth"), op: checkOp, value: z.number().finite(), days: checkDays }).strict(),
    z.object({ kind: z.literal("kubera_item"), name: z.string().trim().min(1).max(80), op: checkOp, value: z.number().finite() }).strict(),
    z.object({ kind: z.literal("metric"), venture: goalVenture, key: z.string().trim().min(1).max(60), op: checkOp, value: z.number().finite(), days: checkDays }).strict(),
  ]);
  api.put("/goals/:id", async (c) => {
    const p = z.object({ name: z.string().trim().min(1).max(160).optional(), pct: z.number().min(0).max(100).optional(), deadline: z.union([goalDate, z.literal(""), z.null()]).optional(), primary: z.literal(true).optional(),
      horizon: goalHorizon.nullable().optional(), venture: goalVenture.nullable().optional(), parent: z.string().max(64).nullable().optional(),
      benchmarks: z.array(z.object({ text: z.string().trim().min(1).max(200), weight: z.number().min(1).max(100).optional(), done: z.boolean().optional(), check: goalCheck.nullable().optional() })).max(12).optional(),
      benchmarksDone: z.object({ done: z.array(z.string().max(200)).max(12).optional(), undone: z.array(z.string().max(200)).max(12).optional() }).optional(),
      benchmarkChecks: z.record(z.string().max(64), goalCheck.nullable()).optional() })
      .strict().refine((v) => Object.keys(v).length > 0, "nothing to change").safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "bad body" }, 400);
    try {
      let goal = await jarvis.updateGoal(c.req.param("id"), p.data as Parameters<typeof jarvis.updateGoal>[1]);
      if (!goal) return c.json({ error: "not found" }, 404);
      // A check just set (or resumed) is read straight away, so Phil sees the figure beside it without waiting an hour.
      if (p.data.benchmarkChecks && Object.values(p.data.benchmarkChecks).some(Boolean)) { await jarvis.syncGoalChecks(goal.id); goal = (await jarvis.goals()).find((g) => g.id === goal!.id) ?? goal; }
      return c.json({ goal, goals: await jarvis.goals() });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  // Read every checked benchmark now (the hourly routine does the same).
  api.post("/goals/check", async (c) => { const r = await jarvis.syncGoalChecks(); return c.json({ ...r, goals: await jarvis.goals() }); });
  // Beside the goals: trophies, each venture's level, today's three and the streak. For Phil's screens only.
  api.get("/base", async (c) => c.json(await jarvis.baseSummary()));
  api.post("/today/repick", async (c) => { await jarvis.repickToday(); return c.json(await jarvis.baseSummary()); });
  api.post("/today/:id/toggle", async (c) => ((await jarvis.toggleToday(c.req.param("id"))) ? c.json(await jarvis.baseSummary()) : c.json({ error: "not found" }, 404)));
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
  // What the next phase's agents still lack (connections), so Phil knows who starts thin before flipping the switch.
  api.get("/phase/readiness", async (c) => {
    const connected = await connectedNow();
    const phase = Math.min(3, Math.max(0, Number(c.req.query("phase") ?? (await jarvis.store.settings.get("phase", 0)) + 1)));
    return c.json({ phase, agents: phaseReadiness(phase, connected) });
  });
  // Setup quests: each live agent's missing connections and whether it has been tried; and a first check-in.
  api.get("/setup", async (c) => c.json({ agents: await jarvis.setupStatus() }));
  api.post("/agents/:id/try", async (c) => {
    const r = await jarvis.tryAgent(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "no such agent" }, 404);
  });
  api.post("/phase", async (c) => {
    const p = z.object({ phase: z.number().int().min(0).max(3) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "phase 0-3" }, 400);
    await jarvis.store.settings.set("phase", p.data.phase);
    await jarvis.router.log("jarvis", "system", `Phil moved the web to Phase ${p.data.phase}`);
    void jarvis.syncSetupGoal().catch(() => undefined);
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
    eagleview: connectors.eagleview ? await connectors.eagleview.status() : { configured: false },
    leadperfection: connectors.leadperfection ? await connectors.leadperfection.status() : { configured: false },
    discord: connectors.discord ? await connectors.discord.status() : { configured: false },
    github: connectors.github ? await connectors.github.status() : { configured: false },
    robinhood: connectors.robinhood ? await connectors.robinhood.status() : { configured: false, connected: false },
    xsearch: { configured: !!process.env.XAI_API_KEY, model: process.env.XAI_SEARCH_MODEL || "grok-4.7", grokMode: process.env.GROK_MODE || "cli" },
    video: jarvis.videoStatus(),
    workshop: { configured: !!connectors.workshop, dir: connectors.workshop?.dir, canShip: !!process.env.GITHUB_PUSH_TOKEN, last: await jarvis.store.settings.get("workshop.ship", null), autoShip: await jarvis.store.settings.get(AUTO_SHIP_KEY, false) },
    telegram: { configured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) },
    ntfy: { configured: !!process.env.NOTIFY_WEBHOOK_URL },
  }));
  // Settings › Connections check: one real read-only call to every connection (or the ones named), and what was
  // last seen for each. The same probes are behind Einstein's connections_check.
  const probes = connectionProbes(jarvis, connectors);
  jarvis.connectionProbes = () => probes;
  api.get("/connectors/check", async (c) => {
    const seen = await lastChecks(jarvis.store);
    return c.json({ results: probes.map((p) => seen.find((r) => r.id === p.id) ?? { id: p.id, name: p.name, what: p.what }) });
  });
  let checking: Promise<unknown> | undefined;
  let saving: Promise<Awaited<ReturnType<typeof saveChecks>>> = Promise.resolve([]);
  api.post("/connectors/check", async (c) => {
    const { only } = (await c.req.json().catch(() => ({}))) as { only?: unknown };
    const ids = Array.isArray(only) ? only.filter((x): x is string => typeof x === "string").slice(0, 40) : undefined;
    if (ids?.length && !probes.some((p) => ids.includes(p.id))) return c.json({ error: "no connection by that name" }, 400);
    // A second press while a full check runs waits for it rather than signing in to everything twice.
    if (!ids?.length && checking) await checking.catch(() => undefined);
    const work = runChecks(probes, { only: ids });
    if (!ids?.length) checking = work.finally(() => { checking = undefined; });
    const results = await work;
    // Settings asks for each connection on its own, side by side: the saves go one at a time so none overwrites another.
    const all = await (saving = saving.catch(() => []).then(() => saveChecks(jarvis.store, results, probes.map((p) => p.id))));
    const bad = results.filter((r) => r.state === "failed");
    if (!ids?.length) await jarvis.router.log("jarvis", "system", `Phil checked every connection: ${results.filter((r) => r.state === "ok").length} working${bad.length ? `, ${bad.length} not (${bad.map((r) => r.name).join(", ")})` : ""}`);
    return c.json({ results: probes.map((p) => all.find((r) => r.id === p.id) ?? { id: p.id, name: p.name, what: p.what }), checked: results.map((r) => r.id) });
  });
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
    try { return c.json({ url: (await connectors.robinhood.authUrl()).url, pasteBack: connectors.robinhood.pasteBack }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  // Robinhood returns the sign-in to localhost; Phil pastes that address here and HQ finishes connecting.
  api.post("/connectors/robinhood/finish", async (c) => {
    if (!connectors.robinhood) return c.json({ error: "Robinhood connector not configured" }, 400);
    const { url } = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    if (typeof url !== "string" || !url.trim() || url.length > 4000) return c.json({ error: "paste the address from your browser" }, 400);
    try {
      await connectors.robinhood.finishFromUrl(url);
      await jarvis.router.log("jarvis", "system", "Phil connected Robinhood");
      return c.json({ ok: true });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
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
  // Settings › Glasses: pair (the key is shown once), see when they were last heard from, unpair.
  api.get("/glasses", async (c) => c.json(await glassesStatus(jarvis.store)));
  api.post("/glasses/pair", async (c) => {
    const key = await pairGlasses(jarvis.store);
    await jarvis.router.log("jarvis", "system", "Phil paired his glasses (a new pairing key; any earlier one stopped working)");
    return c.json({ key, ...(await glassesStatus(jarvis.store)) });
  });
  api.delete("/glasses/pair", async (c) => {
    await unpairGlasses(jarvis.store);
    await jarvis.router.log("jarvis", "system", "Phil unpaired his glasses");
    return c.json(await glassesStatus(jarvis.store));
  });
  // Settings › Hyperliquid and › Polymarket: wallets agents read by public address (never a key), and a check that reads them.
  const wallets = [
    { base: "hyperliquid", key: HL_ACCOUNTS_KEY, list: hlAccounts, read: accountText, who: "Pentoshi" },
    { base: "lighter", key: LIGHTER_ACCOUNTS_KEY, list: lighterAccounts, read: lighterAccountText, who: "Pentoshi" },
    { base: "polymarket", key: POLY_ACCOUNTS_KEY, list: polyAccounts, read: polyPositionsText, who: "Cat" },
  ] as const;
  for (const w of wallets) {
    api.get(`/${w.base}/accounts`, async (c) => c.json({ accounts: await w.list(jarvis.store), ...(w.base === "hyperliquid" ? { trading: connectors.hlTrader ? await connectors.hlTrader.status() : { trading: false, problem: "add an API wallet's key as HYPERLIQUID_AGENT_KEY on the server" } } : {}) }));
    api.put(`/${w.base}/accounts`, async (c) => {
      const { accounts } = (await c.req.json().catch(() => ({}))) as { accounts?: unknown };
      if (!Array.isArray(accounts) || accounts.length > 10) return c.json({ error: "a list of up to 10 accounts" }, 400);
      const list: { label: string; address: string }[] = [];
      for (const a of accounts as { label?: unknown; address?: unknown }[]) {
        const address = typeof a?.address === "string" ? a.address.trim() : "";
        if (!isHlAddress(address)) return c.json({ error: `That isn't a wallet address (0x and 40 letters or digits)${/^(0x)?[0-9a-fA-F]{64}$/.test(address) ? "; it looks like a private key, so it wasn't saved anywhere. Never paste a private key here" : ""}. Paste the public address.` }, 400);
        list.push({ address, label: (typeof a.label === "string" && a.label.trim() ? a.label.trim() : `Account ${list.length + 1}`).slice(0, 40) });
      }
      await jarvis.store.settings.set(w.key, list);
      await jarvis.router.log("jarvis", "system", `Phil set ${list.length} ${w.base} account${list.length === 1 ? "" : "s"} for ${w.who} to read`);
      return c.json({ accounts: list });
    });
    api.post(`/connectors/${w.base}/test`, async (c) => {
      const all = await w.list(jarvis.store);
      if (!all.length) return c.json({ error: `no ${w.base} address set` }, 400);
      try { return c.json({ ok: true, summary: (await Promise.all(all.map((x) => w.read(x)))).join("\n\n") }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
    });
  }
  // Settings › Kalshi: whether trading is set up, what the account holds, and Phil's parameters for Cat.
  api.get("/kalshi", async (c) => c.json(connectors.kalshi ? await connectors.kalshi.status(true) : { trading: false, problem: "add a Kalshi API key on the server (KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_FILE)", limits: {} }));
  api.put("/kalshi/limits", async (c) => {
    if (!connectors.kalshi) return c.json({ error: "Kalshi trading isn't set up (KALSHI_API_KEY_ID)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let limits;
    try { limits = await connectors.kalshi.setLimits({ auto: b.auto === true, maxOrderUsd: b.maxOrderUsd as number | undefined, maxDayUsd: b.maxDayUsd as number | undefined, maxOpenUsd: b.maxOpenUsd as number | undefined }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
    await jarvis.router.log("jarvis", "system", `Phil set the Kalshi parameters: ${kalshiLimitsText(limits)}`);
    return c.json({ limits });
  });
  // Settings › Hyperliquid: Phil's own trading limits (a cap per trade and per day; empty switches one off).
  api.put("/hyperliquid/limits", async (c) => {
    if (!connectors.hlTrader) return c.json({ error: "Hyperliquid trading isn't set up (HYPERLIQUID_AGENT_KEY)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // Passed as typed ("1,000" is 1000; "abc" is refused): setLimits reads them strictly.
    const n = (v: unknown) => v as number | undefined;
    let limits;
    try { limits = await connectors.hlTrader.setLimits({ maxTradeUsd: n(b.maxTradeUsd), maxDayUsd: n(b.maxDayUsd), auto: b.auto === true, maxLeverage: n(b.maxLeverage), maxOpenUsd: n(b.maxOpenUsd), maxDayLossUsd: n(b.maxDayLossUsd), coins: Array.isArray(b.coins) ? (b.coins as string[]) : typeof b.coins === "string" ? b.coins.split(/[\s,]+/) : [] }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
    await jarvis.router.log("jarvis", "system", `Phil set the Hyperliquid parameters: ${limitsText(limits)}`);
    return c.json({ limits });
  });
  // Settings › GitHub: every repo the key reads, and which agents read each one.
  api.get("/github/repos", async (c) => {
    if (!connectors.github) return c.json({ error: "GITHUB_READ_TOKEN isn't set" }, 400);
    try {
      const repos = (await connectors.github.repos()).map((r) => ({ name: r.full_name, description: r.description ?? "", private: !!r.private, language: r.language ?? "", pushed: r.pushed_at ?? "" }));
      return c.json({ repos, access: await connectors.github.access(), agents: AGENTS.filter((a) => a.id !== "jarvis").map((a) => ({ id: a.id, name: a.name, venture: a.venture })) });
    } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  api.put("/github/access", async (c) => {
    if (!connectors.github) return c.json({ error: "GITHUB_READ_TOKEN isn't set" }, 400);
    const { repo, agents } = (await c.req.json().catch(() => ({}))) as { repo?: unknown; agents?: unknown };
    if (typeof repo !== "string" || !Array.isArray(agents) || agents.some((a) => typeof a !== "string" || (a !== "*" && !AGENTS.some((x) => x.id === a)))) return c.json({ error: "repo and a list of agent ids" }, 400);
    try {
      const access = await connectors.github.setAccess(repo, agents as string[]);
      await jarvis.router.log("jarvis", "system", `Phil set who reads ${repo} on GitHub: ${(agents as string[]).join(", ") || "nobody"}`);
      return c.json({ access });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  api.post("/connectors/github/test", async (c) => {
    if (!connectors.github) return c.json({ error: "GITHUB_READ_TOKEN isn't set" }, 400);
    try { return c.json({ ok: true, summary: await connectors.github.check() }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  api.post("/connectors/ghl/test", async (c) => {
    if (!connectors.ghl) return c.json({ error: "GHL_API_KEY and GHL_LOCATION_ID aren't set" }, 400);
    try { return c.json({ ok: true, summary: `${await connectors.ghl.check()}\n${await connectors.ghl.conversationsText(await connectors.ghl.conversations(true, 5), true)}` }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  api.post("/connectors/leadperfection/test", async (c) => {
    if (!connectors.leadperfection) return c.json({ error: "LP_USER and LP_PASSWORD aren't set" }, 400);
    try { return c.json({ ok: true, summary: await connectors.leadperfection.check() }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  api.post("/connectors/eagleview/test", async (c) => {
    if (!connectors.eagleview) return c.json({ error: "EAGLEVIEW_CLIENT_ID and EAGLEVIEW_CLIENT_SECRET aren't set" }, 400);
    try { return c.json({ ok: true, summary: `${await connectors.eagleview.check()}\n${await connectors.eagleview.reportsText(await connectors.eagleview.reports(5))}` }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  // The video reader's key, from Settings. Write-only: the key goes in, is sealed in the store, and is never read back
  // out through the API. A key Google refuses outright isn't kept; one that can't be checked (Google unreachable) is,
  // with a warning, so a network blip doesn't make Phil paste it again.
  api.post("/video/key", async (c) => {
    const p = z.object({ key: z.string().min(1).max(400) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "paste the key" }, 400);
    try { await jarvis.secrets.set("GEMINI_API_KEY", p.data.key); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    try {
      const summary = await jarvis.videoCheck();
      await jarvis.router.log("jarvis", "system", "Phil saved a Gemini key in Settings; Google accepted it and every agent can watch videos now");
      return c.json({ ok: true, summary });
    } catch (e) {
      const msg = (e as Error).message;
      if (/refused the key/.test(msg)) { await jarvis.secrets.clear("GEMINI_API_KEY"); return c.json({ error: `${msg}. Nothing was saved; check the key in aistudio.google.com/apikey and paste it again.` }, 400); }
      return c.json({ ok: false, summary: `Saved, but HQ couldn't confirm it with Google just now (${msg}). Use Check now in a minute.` });
    }
  });
  api.delete("/video/key", async (c) => {
    await jarvis.secrets.clear("GEMINI_API_KEY");
    await jarvis.router.log("jarvis", "system", "Phil removed the Gemini key from Settings; video reading is off until a new one is saved");
    return c.json({ ok: true });
  });
  api.post("/video/test", async (c) => {
    try { return c.json({ ok: true, summary: await jarvis.videoCheck() }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  // Check the Kubera key works (one call, cached for 20 minutes) and show the net worth line.
  api.post("/connectors/kubera/test", async (c) => {
    if (!connectors.kubera) return c.json({ error: "KUBERA_API_KEY and KUBERA_SECRET aren't set" }, 400);
    try { return c.json({ ok: true, summary: await connectors.kubera.summary() }); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });
  // Backups: the last run, and run one now.
  api.get("/backup", async (c) => c.json({ last: await backupStatus(jarvis.store), dir: process.env.BACKUP_DIR ?? "/var/backups/jarvis", drive: !!connectors.google, healthcheck: !!process.env.HEALTHCHECK_URL }));
  // The last deploy for Settings: the deploy script's verdict (Einstein's ships and deploys by hand alike), the commit
  // HQ is running, the ship it belonged to if any, and when this process came up.
  api.get("/deploy", async (c) => c.json({
    ...(connectors.workshop ? await connectors.workshop.lastDeploy() : { last: null, live: null }),
    ship: await jarvis.store.settings.get(SHIP_KEY, null),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  }));
  // Done for you: reversible work agents did on their own, with Undo; and Phil's switch for it.
  api.get("/autodone", async (c) => c.json({ on: await jarvis.reversibleOn(), items: await jarvis.autoDone(count(c.req.query("limit"), 50, 200)) }));
  api.post("/autodone/:id/undo", async (c) => { const r = await jarvis.undoAuto(c.req.param("id")); return c.json(r, r.ok ? 200 : r.result === "not found" ? 404 : 409); });
  api.post("/autonomy", async (c) => {
    const p = z.object({ reversible: z.boolean() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "reversible: true or false" }, 400);
    await jarvis.setReversible(p.data.reversible);
    return c.json({ on: p.data.reversible });
  });
  // Phil's auto-ship switch for Einstein's guardrail-free changes; and "check for an update now".
  api.post("/workshop/autoship", async (c) => {
    const p = z.object({ on: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "on: true or false" }, 400);
    await jarvis.store.settings.set(AUTO_SHIP_KEY, p.data.on);
    await jarvis.router.log("einstein", "system", `Phil turned auto-ship ${p.data.on ? "on: Einstein's changes that touch no guardrails go out once their checks pass (3 a day at most)" : "off: every change waits for Phil"}`);
    return c.json({ on: p.data.on });
  });
  api.post("/update/check", async (c) => c.json({ result: await jarvis.checkForUpdate() }));
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
    const named = d ? undefined : (await getDocs(jarvis.store, [id]))[0]?.name;
    const f = d ?? (await loadFile(id).then((x) => (x ? { name: named ?? id, ...x } : undefined)));
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
    const rotate = ((await c.req.json().catch(() => null)) as { rotate?: boolean } | null)?.rotate === true;
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
