import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, coinalyzeLiquidationsText, marketsFor, windows, clearCoinalyzeCache, COINGLASS_TOOLS, HL_ACCOUNTS_KEY } from "../src/index.js";

const ME = "0x1111111111111111111111111111111111111111";
const NOW = Date.parse("2026-11-23T18:00:00Z");
const EX = [{ name: "Binance", code: "A" }, { name: "Bybit", code: "6" }, { name: "OKX", code: "3" }, { name: "Hyperliquid", code: "H" }, { name: "SmallEx", code: "Z" }];
const mk = (symbol: string, exchange: string, base: string, quote = "USDT", perp = true, margined = "STABLE") => ({ symbol, exchange, base_asset: base, quote_asset: quote, is_perpetual: perp, margined });
const MARKETS = [mk("BTCUSDT_PERP.A", "A", "BTC"), mk("BTCUSD_PERP.A", "A", "BTC", "USD", true, "COIN"), mk("BTCUSDT.6", "6", "BTC"), mk("BTC-USDT-SWAP.3", "3", "BTC"), mk("BTC.H", "H", "BTC", "USD"), mk("BTCUSDT_PERP.Z", "Z", "BTC"), mk("BTCUSDT_231229.A", "A", "BTC", "USDT", false), mk("ETHUSDT_PERP.A", "A", "ETH"), mk("ETH.H", "H", "ETH", "USD")];
/** A stand-in Coinalyze (and Hyperliquid for Phil's positions): what was asked, with what key. */
function setup(opts: { status?: number; retry?: string } = {}) {
  const asked: { url: string; key?: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "api.hyperliquid.xyz") {
      const b = JSON.parse(String(init?.body)) as { type: string };
      if (b.type === "userRole") return Response.json({ role: "user" });
      return Response.json({ assetPositions: [{ position: { coin: "ETH", szi: "-5", positionValue: "10000", liquidationPx: "2200" } }] });
    }
    asked.push({ url: u.pathname.replace("/v1", "") + u.search, key: (init?.headers as Record<string, string>).api_key });
    if (opts.status) return Response.json({ message: "nope" }, { status: opts.status, headers: opts.retry ? { "retry-after": opts.retry } : {} });
    if (u.pathname.endsWith("/future-markets")) return Response.json(MARKETS);
    if (u.pathname.endsWith("/exchanges")) return Response.json(EX);
    if (u.pathname.endsWith("/liquidation-history")) {
      const t = (minsAgo: number) => Math.floor((NOW - minsAgo * 60_000) / 1000);
      return Response.json(u.searchParams.get("symbols")!.split(",").map((symbol) => ({ symbol, history: symbol.startsWith("ETH")
        ? [{ t: t(30), l: 100_000, s: 1_300_000 }, { t: t(200), l: 400_000, s: 1_200_000 }, { t: t(1000), l: 4_500_000, s: 12_500_000 }]
        : [{ t: t(20), l: 1_000_000, s: 250_000 }, { t: t(180), l: 500_000, s: 500_000 }, { t: t(1300), l: 3_000_000, s: 1_000_000 }] })));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { asked, f };
}
async function store() { const s = memoryStore(); await s.init(); await s.settings.set(HL_ACCOUNTS_KEY, [{ label: "Main", address: ME }]); return s; }

test("a coin is summed over its main perps on the big venues: one per venue, stable-margined first, no dated futures, no small venues", () => {
  assert.deepEqual(marketsFor("BTC", MARKETS, EX), [{ symbol: "BTCUSDT_PERP.A", venue: "Binance" }, { symbol: "BTCUSDT.6", venue: "Bybit" }, { symbol: "BTC-USDT-SWAP.3", venue: "OKX" }, { symbol: "BTC.H", venue: "Hyperliquid" }]);
  assert.deepEqual(marketsFor("DOGE", MARKETS, EX), []);
  const w = windows([{ symbol: "x", history: [{ t: (NOW - 10 * 60_000) / 1000, l: 5, s: 1 }, { t: (NOW - 3 * 3_600_000) / 1000, l: 10, s: 2 }, { t: (NOW - 30 * 3_600_000) / 1000, l: 99, s: 99 }] }], NOW);
  assert.deepEqual(w, { "1h": { long: 5, short: 1 }, "4h": { long: 15, short: 3 }, "24h": { long: 15, short: 3 } });
});

test("liquidations in words from the free source: Phil's own position first with its liquidation distance, then BTC and the rest", async () => {
  clearCoinalyzeCache();
  const { f, asked } = setup();
  const t = await coinalyzeLiquidationsText(await store(), undefined, { key: "free-1", fetch: f, now: NOW });
  const lines = t.split("\n");
  // ETH is on two venues here: each window is the two markets added up. He is short it, so it comes first.
  assert.match(lines[1]!, /^ETH: 1h \$2\.8M \(longs \$200K, shorts \$2\.6M; mostly shorts\) · 4h \$6\.0M \(longs \$1\.0M, shorts \$5\.0M; mostly shorts\) · 24h \$40\.0M \(longs \$10\.0M, shorts \$30\.0M; mostly shorts\) \[Binance, Hyperliquid\]$/);
  assert.match(lines[2]!, /Phil is short \$10K, liquidation at 2,200 \(10\.0% away\)\./);
  assert.match(lines[3]!, /^BTC: 1h \$5\.0M \(longs \$4\.0M, shorts \$1\.0M; mostly longs\) · 4h \$9\.0M \(longs \$6\.0M, shorts \$3\.0M; mostly longs\) · 24h \$25\.0M .* \[Binance, Bybit, OKX, Hyperliquid\]$/);
  assert.match(lines[4]!, /^SOL: Coinalyze lists no perp market for it/);
  assert.match(t, /price levels where liquidations would cluster aren't in this/);
  assert.ok(asked.every((a) => a.key === "free-1"), "the key goes in the api_key header");
  const hist = asked.filter((a) => a.url.startsWith("/liquidation-history"));
  assert.equal(hist.length, 1, "every market in one request");
  assert.match(hist[0]!.url, /interval=15min&from=\d+&to=\d+&convert_to_usd=true$/);
  // The lists are kept for a day and the numbers for two minutes: a second scan asks nothing.
  await coinalyzeLiquidationsText(await store(), undefined, { key: "free-1", fetch: f, now: NOW + 60_000 });
  assert.equal(asked.length, 3);
});

test("Coinalyze's refusals are said plainly, and the tool uses the free key when it is there", async () => {
  clearCoinalyzeCache();
  await assert.rejects(coinalyzeLiquidationsText(await store(), undefined, { key: "k", fetch: setup({ status: 401 }).f, now: NOW }), /Coinalyze refused the key \(nope\)/);
  clearCoinalyzeCache();
  await assert.rejects(coinalyzeLiquidationsText(await store(), undefined, { key: "k", fetch: setup({ status: 429, retry: "12" }).f, now: NOW }), /rate limit is hit; it says to wait 12 seconds/);
  const tool = COINGLASS_TOOLS.find((t) => t.name === "liquidations")!;
  const was = { a: process.env.COINALYZE_API_KEY, g: process.env.COINGLASS_API_KEY };
  delete process.env.COINALYZE_API_KEY; delete process.env.COINGLASS_API_KEY;
  assert.match(await tool.handler({}, { store: await store(), agentId: "pentoshi" }), /^Liquidations: not connected yet \(Phil adds a free Coinalyze key/);
  if (was.a) process.env.COINALYZE_API_KEY = was.a; if (was.g) process.env.COINGLASS_API_KEY = was.g;
});
