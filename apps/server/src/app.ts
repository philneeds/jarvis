import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { AGENTS, VENTURES, MODELS, SCHEDULES, findAgent, usageSummary, type Jarvis } from "@jarvis/core";
import { authEnabled, isAuthed, login, logout, requireAuth } from "./auth.js";

export function createApp(jarvis: Jarvis) {
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
    return c.json({ brief: last });
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

  api.get("/phase", async (c) => c.json({ phase: await jarvis.store.settings.get("phase", 0) }));
  api.post("/phase", async (c) => {
    const p = z.object({ phase: z.number().int().min(0).max(3) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "phase 0-3" }, 400);
    await jarvis.store.settings.set("phase", p.data.phase);
    await jarvis.router.log("jarvis", "system", `Phil moved the web to Phase ${p.data.phase}`);
    return c.json({ phase: p.data.phase });
  });

  api.get("/roster", (c) => c.json({ agents: AGENTS, ventures: VENTURES, models: MODELS }));

  app.route("/api", api);
  return app;
}
