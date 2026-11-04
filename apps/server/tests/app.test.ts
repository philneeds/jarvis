import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JARVIS_MOCK = "1";
process.env.HQ_PASSWORD = "open-sesame";
const { Jarvis, memoryStore } = await import("@jarvis/core");
const { createApp } = await import("../src/app.js");

const { TradingGuard, parseTrade } = await import("@jarvis/core");
const store = memoryStore();
await store.init();
const jarvisInst = new Jarvis({ store });
const guard = new TradingGuard(store);
jarvisInst.addConnector(guard, TradingGuard.promptHint());
jarvisInst.onApprovalRequested(async (a) => { if ((a.payload as { action?: string } | undefined)?.action !== "trade.execute") return undefined; const c = await guard.check(parseTrade(a.payload)); return c.ok ? undefined : c.reason; });
const app = createApp(jarvisInst, { guard });

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`http://hq${path}`, { ...init, headers });
}

test("login gates the API", async () => {
  assert.equal((await call("/api/state")).status, 401);
  const bad = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }) });
  assert.equal(bad.status, 401);
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const state = await call("/api/state", { cookie });
  assert.equal(state.status, 200);
  const j = await state.json() as { agents: unknown[]; status: { level: string } };
  assert.equal(j.agents.length, 53);
  assert.equal(j.status.level, "green");

  const quick = await call("/api/chat", { method: "POST", cookie, body: JSON.stringify({ text: "@stella anything new?" }) });
  const qj = await quick.json() as { messages: { role: string }[]; pending?: boolean; replyTo: string };
  assert.equal(qj.pending, true);
  assert.equal(qj.messages[0]!.role, "phil");
  const chat = await call("/api/chat", { method: "POST", cookie, body: JSON.stringify({ text: "@stella anything new?", wait: true }) });
  const cj = await chat.json() as { messages: { role: string; agentId?: string; kind?: string }[] };
  assert.equal(cj.messages.find((m) => m.kind === "final")!.agentId, "stella");

  const kill = await call("/api/kill", { method: "POST", cookie, body: JSON.stringify({ scope: "all", paused: true }) });
  assert.equal(((await kill.json()) as { status: { level: string } }).status.level, "red");
  await call("/api/kill", { method: "POST", cookie, body: JSON.stringify({ scope: "all", paused: false }) });

  const act = await call("/api/activity?q=stella", { cookie });
  assert.ok(((await act.json()) as { entries: unknown[] }).entries.length > 0);
});

test("agent settings round-trip and passkey registration needs a session", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const put = await call("/api/agents/stella/config", { method: "PUT", cookie, body: JSON.stringify({ persona: { job: "Run JD PM." }, tools: ["memory_search"], rules: { autoApprove: ["record"], maxAutoDollars: 250 }, schedule: { enabled: true, when: "daily@06:50", task: "Leads" } }) });
  assert.equal(put.status, 200);
  const get = await call("/api/agents/stella/config", { cookie });
  const j = (await get.json()) as { config: { persona: { job: string }; tools: string[]; rules: { maxAutoDollars: number } } };
  assert.equal(j.config.persona.job, "Run JD PM.");
  assert.deepEqual(j.config.tools, ["memory_search"]);
  assert.equal(j.config.rules.maxAutoDollars, 250);
  const bad = await call("/api/agents/stella/config", { method: "PUT", cookie, body: JSON.stringify({ schedule: { enabled: true, when: "whenever", task: "x" } }) });
  assert.equal(bad.status, 400);
  assert.equal((await call("/api/passkeys/register/options", { method: "POST" })).status, 401);
  const opts = await call("/api/passkeys/register/options", { method: "POST", cookie });
  assert.equal(opts.status, 200);
  assert.equal(((await opts.json()) as { rp: { id: string } }).rp.id, "localhost");
  assert.equal((await call("/api/passkeys/login/options", { method: "POST" })).status, 404);
});

test("Mayne's limits over the API", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const t0 = (await (await call("/api/trading", { cookie })).json()) as { limits: { maxPositionUsd: number } };
  assert.equal(t0.limits.maxPositionUsd, 250);
  const put = await call("/api/trading/limits", { method: "PUT", cookie, body: JSON.stringify({ maxPositionUsd: 100, autoStopDrawdownPct: 5 }) });
  assert.equal(((await put.json()) as { limits: { maxPositionUsd: number } }).limits.maxPositionUsd, 100);
  assert.equal((await call("/api/trading/limits", { method: "PUT", cookie, body: JSON.stringify({ maxPositionUsd: -1 }) })).status, 400);
  await call("/api/trading/equity", { method: "POST", cookie, body: JSON.stringify({ equityUsd: 1000 }) });
  const dd = (await (await call("/api/trading/equity", { method: "POST", cookie, body: JSON.stringify({ equityUsd: 940 }) })).json()) as { stopped?: string };
  assert.match(dd.stopped!, /drawdown/);
  const st = (await (await call("/api/state", { cookie })).json()) as { status: { killSwitch: { trading: boolean } } };
  assert.equal(st.status.killSwitch.trading, true);
  await call("/api/trading/clear-stop", { method: "POST", cookie });
  await call("/api/kill", { method: "POST", cookie, body: JSON.stringify({ scope: "trading", paused: false }) });
  assert.equal(((await (await call("/api/trading", { cookie })).json()) as { ledger: { stoppedAt?: string } }).ledger.stoppedAt, undefined);
});

test("venture dashboards over the API", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const all = (await (await call("/api/ventures", { cookie })).json()) as { ventures: { venture: { id: string } }[] };
  assert.ok(all.ventures.some((v) => v.venture.id === "jdpm"));
  assert.equal((await call("/api/ventures/jdpm/metrics", { method: "POST", cookie, body: JSON.stringify({ key: "nope", value: 1 }) })).status, 400);
  assert.equal((await call("/api/ventures/jdpm/metrics", { method: "POST", cookie, body: JSON.stringify({ key: "leads_week", value: 6 }) })).status, 200);
  const rec = (await (await call("/api/ventures/jdpm/records", { method: "PUT", cookie, body: JSON.stringify({ kind: "lead", title: "Dana Smith", status: "quoted", fields: { value: 4200 } }) })).json()) as { record: { id: string; status: string } };
  assert.equal(rec.record.status, "quoted");
  const d = (await (await call("/api/ventures/jdpm", { cookie })).json()) as { metrics: { key: string; latest?: number }[]; records: { kind: string; items: unknown[] }[] };
  assert.equal(d.metrics.find((m) => m.key === "leads_week")!.latest, 6);
  assert.equal(d.records.find((k) => k.kind === "lead")!.items.length, 1);
  assert.equal((await call(`/api/ventures/jdpm/records/${rec.record.id}`, { method: "DELETE", cookie })).status, 200);
  assert.equal((await call("/api/ventures/root", { cookie })).status, 404);
});
