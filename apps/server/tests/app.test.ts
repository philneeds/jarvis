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

test("editing and undo over the API: needs-you items, goals, metric readings, memory and records", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const json = async <T,>(r: Response | Promise<Response>) => (await (await r).json()) as T;
  const send = (path: string, method: string, body?: unknown) => call(path, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body) });

  // Needs you: edit in place.
  const { item } = await json<{ item: { id: string } }>(send("/api/attention", "POST", { title: "Renew passport", why: "Expires in March" }));
  const edited = await json<{ item: { title: string; why: string; due?: string } }>(send(`/api/attention/${item.id}`, "PUT", { title: "Renew passport now", due: "2026-12-01" }));
  assert.equal(edited.item.title, "Renew passport now");
  assert.equal(edited.item.why, "Expires in March");
  assert.equal(edited.item.due, "2026-12-01");
  assert.equal((await json<{ item: { due?: string } }>(send(`/api/attention/${item.id}`, "PUT", { due: null }))).item.due, undefined);
  assert.equal((await send(`/api/attention/${item.id}`, "PUT", { title: "" })).status, 400);
  assert.equal((await send(`/api/attention/${item.id}`, "PUT", { due: "next week" })).status, 400);
  assert.equal((await send(`/api/attention/${item.id}`, "PUT", {})).status, 400);
  assert.equal((await send(`/api/attention/${item.id}`, "PUT", { bogus: 1 })).status, 400);
  assert.equal((await call(`/api/attention/${item.id}`, { method: "PUT", cookie, body: "not json" })).status, 400);
  assert.equal((await send("/api/attention/nope", "PUT", { title: "x" })).status, 404);

  // Goals.
  assert.deepEqual((await json<{ goals: unknown[] }>(send("/api/goals", "GET"))).goals, []);
  const g1 = await json<{ goal: { id: string; primary: boolean } }>(send("/api/goals", "POST", { name: "Exit the agency", pct: 10, deadline: "2027-06-01" }));
  assert.equal(g1.goal.primary, true);
  const g2 = await json<{ goal: { id: string } }>(send("/api/goals", "POST", { name: "Get fit" }));
  assert.equal((await send("/api/goals", "POST", { name: " " })).status, 400);
  assert.equal((await send("/api/goals", "POST", { name: "x", pct: 101 })).status, 400);
  assert.equal((await send("/api/goals", "POST", { name: "x", deadline: "soon" })).status, 400);
  const prim = await json<{ goals: { id: string; name: string; primary: boolean; pct: number }[] }>(send(`/api/goals/${g2.goal.id}`, "PUT", { name: "Get properly fit", pct: 35, primary: true }));
  assert.deepEqual(prim.goals.map((g) => [g.name, g.primary, g.pct]), [["Get properly fit", true, 35], ["Exit the agency", false, 10]]);
  assert.equal((await send(`/api/goals/${g2.goal.id}`, "PUT", { primary: false })).status, 400);
  assert.equal((await send(`/api/goals/${g2.goal.id}`, "PUT", {})).status, 400);
  assert.equal((await send("/api/goals/nope", "PUT", { pct: 5 })).status, 404);
  const gdel = await json<{ undoId: string; goals: unknown[] }>(send(`/api/goals/${g1.goal.id}`, "DELETE"));
  assert.equal(gdel.goals.length, 1);
  assert.equal((await send("/api/goals/nope", "DELETE")).status, 404);
  assert.equal((await send(`/api/undo/${gdel.undoId}`, "POST")).status, 200);
  assert.equal((await json<{ goals: unknown[] }>(send("/api/goals", "GET"))).goals.length, 2);
  assert.equal((await send(`/api/undo/${gdel.undoId}`, "POST")).status, 404);

  // A wrong metric reading: correct it, delete it, undo.
  await send("/api/ventures/money/metrics", "POST", { key: "cash", value: 5000, at: "2026-11-01T09:00:00Z" });
  await send("/api/ventures/money/metrics", "POST", { key: "cash", value: 50000, at: "2026-11-02T09:00:00Z" });
  const cash = async () => (await json<{ metrics: { key: string; latest?: number; latestId?: string }[] }>(send("/api/ventures/money", "GET"))).metrics.find((m) => m.key === "cash")!;
  const before = await cash();
  assert.equal(before.latest, 50000);
  assert.equal((await send(`/api/ventures/money/metrics/${before.latestId}`, "PUT", { value: 5200 })).status, 200);
  assert.equal((await cash()).latest, 5200);
  assert.equal((await send(`/api/ventures/money/metrics/${before.latestId}`, "PUT", { value: "lots" })).status, 400);
  assert.equal((await send(`/api/ventures/jdpm/metrics/${before.latestId}`, "PUT", { value: 1 })).status, 404);
  assert.equal((await send(`/api/ventures/nope/metrics/${before.latestId}`, "PUT", { value: 1 })).status, 404);
  const mdel = await json<{ undoId: string }>(send(`/api/ventures/money/metrics/${before.latestId}`, "DELETE"));
  assert.equal((await cash()).latest, 5000);
  assert.equal((await send(`/api/ventures/money/metrics/${before.latestId}`, "DELETE")).status, 404);
  await send(`/api/undo/${mdel.undoId}`, "POST");
  assert.equal((await cash()).latest, 5200);

  // Memory and records: delete returns an undo id.
  await send("/api/memory", "PUT", { scope: "phil", key: "coffee", value: "black" });
  assert.equal((await send("/api/memory?scope=phil", "DELETE")).status, 400);
  assert.equal((await send("/api/memory?scope=phil&key=tea", "DELETE")).status, 404);
  const fm = await json<{ undoId: string }>(send("/api/memory?scope=phil&key=coffee", "DELETE"));
  assert.ok(!(await json<{ items: { key: string }[] }>(send("/api/memory?scope=phil", "GET"))).items.some((i) => i.key === "coffee"));
  await send(`/api/undo/${fm.undoId}`, "POST");
  assert.ok((await json<{ items: { key: string }[] }>(send("/api/memory?scope=phil", "GET"))).items.some((i) => i.key === "coffee"));
  const rec = await json<{ record: { id: string } }>(send("/api/ventures/jdpm/records", "PUT", { kind: "lead", title: "Pat Lee" }));
  const rdel = await json<{ undoId: string }>(send(`/api/ventures/jdpm/records/${rec.record.id}`, "DELETE"));
  assert.equal((await send(`/api/ventures/jdpm/records/${rec.record.id}`, "DELETE")).status, 404);
  await send(`/api/undo/${rdel.undoId}`, "POST");
  assert.equal((await send(`/api/ventures/jdpm/records/${rec.record.id}`, "DELETE")).status, 200);
  assert.equal((await send("/api/undo/nope", "POST")).status, 404);
});
