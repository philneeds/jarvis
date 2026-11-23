import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, liquidationsText, clusters, coinLine, coinglass, clearCoinglassCache, PlanError, HL_ACCOUNTS_KEY, CHARTERS } from "../src/index.js";

const ME = "0x1111111111111111111111111111111111111111";
const row = (symbol: string, h1: [number, number], h4: [number, number], h24: [number, number]) => ({
  symbol,
  liquidation_usd_1h: h1[0] + h1[1], long_liquidation_usd_1h: h1[0], short_liquidation_usd_1h: h1[1],
  liquidation_usd_4h: h4[0] + h4[1], long_liquidation_usd_4h: h4[0], short_liquidation_usd_4h: h4[1],
  liquidation_usd_12h: 0, long_liquidation_usd_12h: 0, short_liquidation_usd_12h: 0,
  liquidation_usd_24h: h24[0] + h24[1], long_liquidation_usd_24h: h24[0], short_liquidation_usd_24h: h24[1],
});
/** A stand-in CoinGlass (and Hyperliquid for Phil's positions): what was asked, and a plan that may lack the map. */
function setup(opts: { plan?: "hobbyist" | "professional"; code?: string; msg?: string } = {}) {
  const asked: { url: string; key?: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "api.hyperliquid.xyz") {
      const b = JSON.parse(String(init?.body)) as { type: string };
      if (b.type === "userRole") return Response.json({ role: "user" });
      return Response.json({ assetPositions: [{ position: { coin: "ETH", szi: "-5", positionValue: "10000", liquidationPx: "2200" } }] });
    }
    asked.push({ url: u.pathname + u.search, key: (init?.headers as Record<string, string>)["CG-API-KEY"] });
    if (opts.code) return Response.json({ code: opts.code, msg: opts.msg });
    if (u.pathname === "/api/futures/liquidation/coin-list") return Response.json({ code: "0", data: [row("BTC", [4e6, 1e6], [9e6, 8e6], [60e6, 20e6]), row("ETH", [0.2e6, 2.6e6], [1e6, 5e6], [10e6, 30e6]), row("SOL", [0, 0], [3e5, 2e5], [4e6, 5e6]), row("DOGE", [7e6, 0], [8e6, 0], [9e6, 1e6])] });
    if (u.pathname === "/api/futures/liquidation/aggregated-map") {
      if (opts.plan !== "professional") return Response.json({ code: "403", msg: "Upgrade plan" });
      return Response.json({ code: "0", data: { last_price: 2000, data: [
        { liqMapV2: { "2080": [[2080, 500, 25, "h1"]], "2082": [[2082, 300, 50, "h2"]], "2150": [[2150, 90, 10, null]], "1900": [[1900, 700, 25, "h1"]], "1500": [[1500, 9999, 5, "h1"]] } },
        { liqMapV2: { "2081": [[2081, 400, 25, "h1"]], "1960": [[1960, 100, null, null]] } },
      ] } });
    }
    return Response.json({ code: "404", msg: "no such endpoint" });
  }) as typeof fetch;
  return { asked, f };
}
async function store() { const s = memoryStore(); await s.init(); await s.settings.set(HL_ACCOUNTS_KEY, [{ label: "Main", address: ME }]); return s; }

test("liquidations in words: the market, the hour's biggest, and each coin with longs against shorts; Phil's own position first", async () => {
  clearCoinglassCache();
  const { f, asked } = setup();
  const t = await liquidationsText(await store(), undefined, { key: "k-1", fetch: f });
  assert.match(t, /^Liquidations across exchanges \(CoinGlass\): \$135\.0M in the last 24h \(longs \$83\.0M, shorts \$56\.0M\)|^Liquidations across exchanges \(CoinGlass\): \$139\.0M in the last 24h \(longs \$83\.0M, shorts \$56\.0M\), \$14\.8M in the last hour\./);
  assert.match(t, /Biggest in the last hour: DOGE \$7\.0M \(longs\), BTC \$5\.0M \(longs\), ETH \$2\.8M \(shorts\)\./);
  // He is short ETH: it comes first, with how far his liquidation is.
  const lines = t.split("\n");
  assert.match(lines[2]!, /^ETH: 1h \$2\.8M \(longs \$200K, shorts \$2\.6M; mostly shorts\) · 4h \$6\.0M \(longs \$1\.0M, shorts \$5\.0M; mostly shorts\) · 24h \$40\.0M/);
  assert.match(lines[3]!, /Phil is short \$10K, liquidation at 2,200 \(10\.0% away\)\./);
  assert.ok(lines.some((l) => /^BTC: 1h \$5\.0M \(longs \$4\.0M, shorts \$1\.0M; mostly longs\)/.test(l)) && lines.some((l) => /^SOL: 1h nothing/.test(l)));
  assert.match(t, /Price levels where liquidations cluster \(the liquidation map\) need CoinGlass's Professional plan; this key's plan gives the totals above only\.$/);
  assert.ok(asked.every((a) => a.key === "k-1"), "the key goes in the CG-API-KEY header");
  assert.equal(asked.filter((a) => /aggregated-map/.test(a.url)).length, 1, "the map isn't asked for again once the plan said no");
  assert.ok(CHARTERS.pentoshi!.tools!.includes("liquidations"));
});

test("with the plan that has it, the levels where liquidations cluster come with the position: nearest heavy levels above and below", async () => {
  clearCoinglassCache();
  const { f, asked } = setup({ plan: "professional" });
  const t = await liquidationsText(await store(), ["eth"], { key: "k-1", fetch: f });
  // 2080/2081/2082 are one cluster (the heaviest above); 1500 is heavy but 25% away, so it isn't "near".
  assert.match(t, /Liquidation clusters near 2,000 \(model; the heaviest near the price, nearest first\): above at 2,0\d\d, 2,1\d\d \(shorts get squeezed there\); below at 1,9\d\d, 1,8\d\d \(longs get flushed there\)\./);
  assert.ok(asked.some((a) => a.url === "/api/futures/liquidation/aggregated-map?symbol=ETH&range=1d"));
  const k = clusters({ last_price: 2000, data: [{ liqMapV2: { "2080": [[2080, 500, 25, "h1"]], "1500": [[1500, 9999, 5, "h1"]] } }] });
  assert.equal(k.above.length, 1); assert.deepEqual(k.below, []);
  assert.equal(coinLine({ symbol: "X", liquidation_usd_1h: 0, liquidation_usd_4h: 0, liquidation_usd_24h: 0 }), "X: 1h nothing · 4h nothing · 24h nothing");
});

test("CoinGlass's errors are read from its own code: a bad key, the rate limit, a plan that lacks the endpoint; no key says so quietly", async () => {
  clearCoinglassCache();
  await assert.rejects(coinglass("/x", { key: "k", fetch: setup({ code: "400", msg: "Invalid API key provided" }).f }), /CoinGlass refused the key: Invalid API key provided/);
  await assert.rejects(coinglass("/y", { key: "k", fetch: setup({ code: "429" }).f }), /rate limit/);
  await assert.rejects(coinglass("/z", { key: "k", fetch: setup({ code: "403", msg: "Upgrade plan" }).f }), PlanError);
  const was = process.env.COINGLASS_API_KEY; delete process.env.COINGLASS_API_KEY;
  await assert.rejects(coinglass("/w", { fetch: setup().f }), /CoinGlass isn't connected yet/);
  if (was) process.env.COINGLASS_API_KEY = was;
  // Answers are kept for a minute, so a scan that asks twice makes one request.
  const { f, asked } = setup();
  await coinglass("/api/futures/liquidation/coin-list", { key: "k", fetch: f, now: 1000 });
  await coinglass("/api/futures/liquidation/coin-list", { key: "k", fetch: f, now: 30_000 });
  assert.equal(asked.length, 1);
});
