import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memoryStore, KuberaConnector } from "../src/index.js";

test("Kubera: signed like the Kubera API v3, cached, read-only, and a daily snapshot gives week-over-week changes", async () => {
  const store = memoryStore(); await store.init();
  let now = Date.parse("2026-11-02T15:00:00Z");
  const calls: { path: string; headers: Record<string, string> }[] = [];
  let checking = 41_000;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const headers = init?.headers as Record<string, string>;
    calls.push({ path: u.pathname, headers });
    // Check the signature exactly as Kubera computes it.
    const expect = createHmac("sha256", "s3cret").update(`key123${headers["x-timestamp"]}GET${u.pathname}`).digest("hex");
    if (headers["x-signature"] !== expect || headers["x-api-token"] !== "key123") return new Response(JSON.stringify({ message: "bad signature" }), { status: 401 });
    if (u.pathname === "/api/v3/data/portfolio") return Response.json({ data: [{ id: "p1", name: "Phil", currency: "USD" }], errorCode: 0 });
    if (u.pathname === "/api/v3/data/portfolio/p1") return Response.json({ data: { id: "p1", name: "Phil", currency: "USD", net_worth: { amount: checking + 60_000 - 15_000 }, assets: [{ name: "ESL Money Maker 3703", value: { amount: checking }, connection: { provider: "Plaid", last_updated: new Date(now).toISOString() } }, { name: "Robinhood", value: { amount: 60_000 }, connection: { provider: "Robinhood", last_updated: "2026-10-20T00:00:00Z" } }], debts: [{ name: "Car loan", value: { amount: 15_000 } }] }, errorCode: 0 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const days: number[] = [];
  const k = new KuberaConnector(store, { apiKey: "key123", secret: "s3cret", fetch: f, now: () => now });
  k.onDaily = async (nw) => { days.push(nw); };
  const first = await k.summary();
  assert.match(first, /Phil: net worth \$86,000 \(assets \$101,000, debts \$15,000\)/);
  assert.match(first, /No earlier snapshot yet/);
  assert.match(first, /Not synced in 3\+ days: Robinhood/);
  const n = calls.length;
  await k.summary();
  assert.equal(calls.length, n, "a second read within 20 minutes uses the cache");
  // A week later ESL is up $1,297.
  now += 7 * 86_400_000; checking += 1_297;
  const later = await k.summary();
  assert.match(later, /\+\$1,297 since 2026-11-02/);
  assert.match(later, /Biggest moves this week: ESL Money Maker 3703 \+\$1,297/);
  assert.deepEqual(days, [86_000, 87_297], "one Money-board reading per day");
  assert.match(await k.tools().find((t) => t.name === "kubera_items")!.handler({ query: "esl" }, { store, agentId: "munger" }), /Asset · ESL Money Maker 3703: \$42,297 · via Plaid/);
  const hist = await k.tools().find((t) => t.name === "kubera_history")!.handler({ days: 30 }, { store, agentId: "munger" });
  assert.match(hist, /Net worth from 2026-11-02 to 2026-11-09 \(2 daily snapshots\): \$86,000 → \$87,297 \(\+\$1,297\)/);
  assert.match(hist, /Change by account over the period: ESL Money Maker 3703 \+\$1,297/);
  assert.match(hist, /Biggest single days: 2026-11-09 \+\$1,297/);
  assert.ok(calls.every((c) => !/item/.test(c.path)), "never calls the write endpoint");
  assert.deepEqual(Object.keys(k.executors()), [], "no actions: read-only");
  const bad = new KuberaConnector(store, { apiKey: "key123", secret: "wrong", fetch: f, now: () => now + 3_600_000 });
  assert.match(await bad.tools()[0]!.handler({}, { store, agentId: "munger" }), /Kubera refused the key/);
});

test("Kubera's errors say what to fix: the clock, or the key / IP restriction", async () => {
  const store = memoryStore(); await store.init();
  const say = (status: number, body: string) => new KuberaConnector(store, { apiKey: "k", secret: "s", fetch: (async () => new Response(body, { status })) as typeof fetch });
  assert.match(await say(400, JSON.stringify({ message: "Invalid timestamp", errorCode: 1 })).tools()[0]!.handler({}, { store, agentId: "munger" }), /clock is more than 5 minutes wrong/);
  assert.match(await say(403, "Forbidden").tools()[0]!.handler({}, { store, agentId: "munger" }), /refused the key \(403: Forbidden\).*IP-restricted/);
});

test("Kubera's real v3 shape is read: asset/debt arrays, netWorth/assetTotal/debtTotal numbers, ticker, providerName/lastUpdated", async () => {
  const store = memoryStore(); await store.init();
  const now = Date.parse("2026-11-17T15:00:00Z");
  const body = { id: "p1", name: "Phil", ticker: "USD", tickerId: 171, assetTotal: 84_500, debtTotal: 15_000, netWorth: 69_500, investable: 60_000,
    asset: [
      { id: "a1", name: "ESL Money Maker 3703", sheetName: "Bank", value: { amount: 24_500, currency: "USD" }, connection: { providerName: "Plaid", lastUpdated: new Date(now).toISOString(), status: "Connected" } },
      { id: "a2", name: "Robinhood", sheetName: "Investments", ticker: "VOO", quantity: 100, value: { amount: 60_000, currency: "USD" }, connection: { providerName: "Robinhood", lastUpdated: "2026-11-01T00:00:00Z", status: "Connection Error", statusReason: "Login needed" } },
      { id: "a3", name: "Old hidden thing", hidden: true, value: { amount: 999, currency: "USD" } },
    ],
    debt: [{ id: "d1", name: "Car loan", value: { amount: 15_000, currency: "USD" }, connection: null }], insurance: [], document: [] };
  const fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/api/v3/data/portfolio") return Response.json({ data: [{ id: "p1", name: "Phil", currency: "USD" }], errorCode: 0 });
    return Response.json({ data: body, errorCode: 0 });
  }) as typeof globalThis.fetch;
  let daily = -1;
  const k = new KuberaConnector(store, { apiKey: "k", secret: "s", fetch, now: () => now });
  k.onDaily = async (nw) => { daily = nw; };
  const s = await k.summary();
  assert.match(s, /Phil: net worth \$69,500 \(assets \$84,500, debts \$15,000\)/);
  assert.match(s, /Not synced in 3\+ days: Robinhood/);
  assert.match(s, /Connection errors in Kubera: Robinhood/);
  assert.equal(daily, 69_500, "the Money board gets the real number");
  const items = await k.itemsText();
  assert.match(items, /Asset · Robinhood \(VOO × 100\): \$60,000 · via Robinhood, synced 2026-11-01/);
  assert.doesNotMatch(items, /Old hidden thing/);
});

test("an empty Kubera read isn't saved as the day's net worth", async () => {
  const store = memoryStore(); await store.init();
  const fetch = (async (url: string) => Response.json({ data: new URL(url).pathname.endsWith("/portfolio") ? [{ id: "p1", name: "Phil", currency: "USD" }] : { id: "p1", name: "Phil", asset: [], debt: [] }, errorCode: 0 })) as typeof globalThis.fetch;
  let called = false;
  const k = new KuberaConnector(store, { apiKey: "k", secret: "s", fetch });
  k.onDaily = async () => { called = true; };
  assert.match(await k.summary(), /sent this portfolio back empty/);
  assert.equal(called, false);
  assert.equal((await k.status()).days, 0);
});
