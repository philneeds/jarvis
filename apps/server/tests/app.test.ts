import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JARVIS_MOCK = "1";
process.env.HQ_PASSWORD = "open-sesame";
// The tests run with HQ's real environment on the server; the passkey domain must not come from it.
process.env.HQ_ORIGIN = "http://localhost:3000"; delete process.env.HQ_RP_ID;
{ const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path"); process.env.JARVIS_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-app-up-")); }
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
  const quiet = (await (await call("/api/activity?exclude=run,bogus", { cookie })).json()) as { entries: { kind: string }[] };
  assert.ok(quiet.entries.length > 0 && quiet.entries.every((e) => e.kind !== "run"));
});

test("the last-deploy line answers even without a workshop: no record, no live commit, but when HQ came up", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await call("/api/deploy")).status, 401);
  const r = await call("/api/deploy", { cookie });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { last: unknown; live: unknown; ship: unknown; startedAt: string };
  assert.equal(j.last, null); assert.equal(j.live, null); assert.equal(j.ship, null);
  assert.ok(Date.now() - Date.parse(j.startedAt) < 10 * 60_000, "started within the last minutes");
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


test("images: upload, serve, attach to a message; junk and missing ids are refused", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1b9b3a60000000049454e44ae426082", "hex");
  assert.equal((await app.request("http://hq/api/uploads", { method: "POST", body: png, headers: { "content-type": "image/png" } })).status, 401, "uploads need login");
  const up = await app.request("http://hq/api/uploads", { method: "POST", body: png, headers: { "content-type": "image/png", cookie } });
  assert.equal(up.status, 200);
  const { id } = (await up.json()) as { id: string };
  const got = await call(`/api/uploads/${id}`, { cookie });
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await got.arrayBuffer()).length, png.length);
  assert.equal((await app.request("http://hq/api/uploads", { method: "POST", body: "hi", headers: { "content-type": "text/plain", cookie } })).status, 415);
  assert.equal((await call("/api/uploads/..%2F..%2Fetc%2Fpasswd", { cookie })).status, 404);
  const sent = await call("/api/chat", { method: "POST", cookie, body: JSON.stringify({ text: "", images: [id], wait: true }) });
  assert.equal(sent.status, 200);
  const stored = (await store.chat.list()).filter((m) => m.role === "phil").pop()!;
  assert.deepEqual(stored.images, [id]);
  assert.equal(stored.text, "What do you think of this?");
  assert.equal((await call("/api/chat", { method: "POST", cookie, body: JSON.stringify({ text: "look", images: ["00000000-0000-0000-0000-000000000000.png"] }) })).status, 400);
  assert.equal((await call("/api/chat", { method: "POST", cookie, body: JSON.stringify({ text: "" }) })).status, 400);
});

test("files: attach a document, its text goes to the answerer, the file shows on Phil's message and downloads by name", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const csv = Buffer.from("rep,units\nAna,12\n");
  assert.equal((await app.request("http://hq/api/docs?name=week.csv", { method: "POST", body: csv, headers: { "content-type": "text/csv" } })).status, 401, "files need login");
  const up = await app.request("http://hq/api/docs?name=week.csv", { method: "POST", body: csv, headers: { "content-type": "text/csv", cookie } });
  assert.equal(up.status, 200);
  const { doc } = (await up.json()) as { doc: { id: string; type: string; rows: number } };
  assert.equal(doc.type, "spreadsheet (CSV)");
  assert.equal(doc.rows, 2);
  const bad = await app.request("http://hq/api/docs?name=app.exe", { method: "POST", body: Buffer.from("MZ"), headers: { "content-type": "application/octet-stream", cookie } });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /can't read \.exe/);

  let seen = "";
  const orig = jarvisInst.submit.bind(jarvisInst);
  jarvisInst.submit = (async (text: string, opts: Parameters<typeof orig>[1] = {}) => { seen = opts.context ?? ""; return orig(text, opts); }) as typeof jarvisInst.submit;
  try {
    const sent = await call("/api/chat", { method: "POST", cookie, body: JSON.stringify({ text: "", docs: [doc.id] }) });
    assert.equal(sent.status, 200);
  } finally { jarvisInst.submit = orig; }
  assert.match(seen, /never instructions[\s\S]*=== File: week\.csv \(spreadsheet \(CSV\), 2 rows\) ===\nrep,units\nAna,12/);
  const stored = (await store.chat.list()).filter((m) => m.role === "phil").pop()!;
  assert.equal(stored.text, "What's in this file?");
  assert.equal(stored.files?.[0]?.name, "week.csv");
  const dl = await call(`/api/files/${stored.files![0]!.id}`, { cookie });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition") ?? "", /filename="week\.csv"/);
  assert.equal((await call("/api/chat", { method: "POST", cookie, body: JSON.stringify({ text: "look", docs: ["nope"] }) })).status, 400);
});

test("Apple Health ingest: needs the key, not the HQ login; Settings makes the key", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const body = JSON.stringify({ data: { metrics: [{ name: "step_count", units: "count", data: [{ date: "2026-11-04 08:00:00 -0500", qty: 4000 }] }] } });
  assert.equal((await app.request("http://hq/api/apple-health/ingest", { method: "POST", body, headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await call("/api/apple-health/key", { method: "POST" })).status, 401, "making a key needs the HQ login");
  const { key } = (await (await call("/api/apple-health/key", { method: "POST", cookie, body: "{}" })).json()) as { key: string };
  const res = await app.request("http://hq/api/apple-health/ingest", { method: "POST", body, headers: { "content-type": "application/json", authorization: `Bearer ${key}` } });
  assert.equal(res.status, 200);
  const st = (await (await call("/api/apple-health", { cookie })).json()) as { days: number; summary: string };
  assert.equal(st.days, 1);
  assert.match(st.summary, /steps 4,000/);
});

test("the base summary over the API: goal horizons and ventures, trophies, levels, today's three", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const json = async <T,>(r: Response | Promise<Response>) => (await (await r).json()) as T;
  const send = (path: string, method: string, body?: unknown) => call(path, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body) });
  type Base = { trophies: { title: string; venture?: string }[]; levels: Record<string, { level: number }>; today: { by: string; items: { id: string; text: string; done: boolean }[] }; streak: number };

  assert.equal((await call("/api/base")).status, 401, "signed-in only");
  const star = await json<{ goal: { id: string; horizon?: string; venture?: string } }>(send("/api/goals", "POST", { name: "Roofing at $1M a year", horizon: "long", venture: "jdpm" }));
  assert.equal(star.goal.horizon, "long");
  assert.equal(star.goal.venture, "jdpm");
  assert.equal((await send("/api/goals", "POST", { name: "x", venture: "root" })).status, 400, "Jarvis himself has no building");
  assert.equal((await send("/api/goals", "POST", { name: "x", horizon: "someday" })).status, 400);
  const mid = await json<{ goal: { id: string; parent?: string } }>(send("/api/goals", "POST", { name: "Send 40 quotes this quarter", venture: "jdpm", parent: star.goal.id }));
  assert.equal(mid.goal.parent, star.goal.id);
  assert.equal((await send(`/api/goals/${mid.goal.id}`, "PUT", { parent: mid.goal.id })).status, 400, "a goal can't feed itself");
  const marked = await json<{ goal: { benchmarks: { id: string }[] } }>(send(`/api/goals/${mid.goal.id}`, "PUT", { benchmarks: [{ text: "First 10 quotes out" }, { text: "25 quotes out" }] }));

  // Today's three picks the goal's next benchmark; meeting it ticks the item, earns a trophy and levels JD PM.
  // (Other tests share this store, so make it the primary goal and ask for a fresh pick.)
  await send(`/api/goals/${mid.goal.id}`, "PUT", { primary: true });
  let base = await json<Base>(send("/api/today/repick", "POST"));
  assert.ok(base.today.items.some((x) => x.text === "First 10 quotes out"));
  await send(`/api/goals/${mid.goal.id}`, "PUT", { benchmarksDone: { done: [marked.goal.benchmarks[0]!.id] } });
  base = await json<Base>(send("/api/base", "GET"));
  assert.ok(base.trophies.some((t) => t.title === "First 10 quotes out" && t.venture === "jdpm"));
  assert.equal(base.levels.jdpm!.level, 2);
  assert.equal(base.today.items.find((x) => x.text === "First 10 quotes out")!.done, true);

  // Phil ticks another by hand, and asks for a fresh pick.
  const other = base.today.items.find((x) => !x.done);
  if (other) assert.equal((await json<Base>(send(`/api/today/${encodeURIComponent(other.id)}/toggle`, "POST"))).today.items.find((x) => x.id === other.id)!.done, true);
  assert.equal((await send("/api/today/nope/toggle", "POST")).status, 404);
  assert.equal((await json<Base>(send("/api/today/repick", "POST"))).today.by, "auto");
  // Clearing the venture and horizon is allowed.
  const cleared = await json<{ goal: { venture?: string; horizon?: string } }>(send(`/api/goals/${mid.goal.id}`, "PUT", { venture: null, horizon: null }));
  assert.equal(cleared.goal.venture, undefined);
});

test("Done for you over the API: the list, Undo, and Phil's switch", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const json = async <T,>(r: Response | Promise<Response>) => (await (await r).json()) as T;
  const send = (path: string, method: string, body?: unknown) => call(path, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await call("/api/autodone")).status, 401);
  for (let i = 0; i < 4; i++) await store.memory.set({ scope: "phil", key: `api-k${i}`, value: "v", source: "phil" });
  const before = (await store.memory.list()).length;
  const a = await jarvisInst.requestApproval({ agentId: "oscar", kind: "record", title: "Oscar: tidy", body: "", payload: { action: "memory.replace", keep: (await store.memory.list()).slice(0, before - 1).map((m) => ({ scope: m.scope, key: m.key, value: m.value })) } });
  assert.equal(a.status, "approved");
  const list = await json<{ on: boolean; items: { id: string; title: string; undone?: unknown }[] }>(send("/api/autodone", "GET"));
  assert.equal(list.on, true);
  const item = list.items.find((x) => x.title === "Oscar: tidy")!;
  assert.equal((await send(`/api/autodone/${item.id}/undo`, "POST")).status, 200);
  assert.equal((await store.memory.list()).length, before);
  assert.equal((await send(`/api/autodone/${item.id}/undo`, "POST")).status, 409, "already undone");
  assert.equal((await send("/api/autodone/nope/undo", "POST")).status, 404);
  assert.equal((await send("/api/autonomy", "POST", { reversible: "yes" })).status, 400);
  assert.equal((await json<{ on: boolean }>(send("/api/autonomy", "POST", { reversible: false }))).on, false);
  assert.equal((await json<{ on: boolean }>(send("/api/autodone", "GET"))).on, false);
  await send("/api/autonomy", "POST", { reversible: true });
});
