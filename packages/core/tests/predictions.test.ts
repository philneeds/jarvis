import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, marketsText, polyPositionsText, polyAccounts, POLY_ACCOUNTS_KEY, PREDICTION_TOOLS, CHARTERS, prefetchTools } from "../src/index.js";

function fake(opts: { kalshiSearchDown?: boolean } = {}) {
  const urls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = new URL(String(url)); urls.push(u.hostname + u.pathname + u.search);
    if (u.hostname === "gamma-api.polymarket.com" && u.pathname === "/markets") return Response.json([{ question: "Fed hikes 25 bps in December?", outcomes: '["Yes","No"]', outcomePrices: '["0.915","0.085"]', bestBid: 0.91, bestAsk: 0.92, oneDayPriceChange: -0.01, volume24hr: 316000, liquidity: "626000", endDate: "2026-12-09T19:00:00Z", events: [{ slug: "fed-december" }] }]);
    if (u.hostname === "gamma-api.polymarket.com" && u.pathname === "/public-search") return Response.json({ events: [{ title: "Bitcoin above ___?", slug: "btc-above", markets: [{ question: "Bitcoin above $100k by Dec 31?", outcomes: '["Yes","No"]', outcomePrices: '["0.12","0.88"]', volume24hr: 50000, liquidity: 20000 }, { question: "No prices yet" }] }] });
    if (u.hostname === "api.elections.kalshi.com" && u.pathname === "/v1/search/series") {
      if (opts.kalshiSearchDown) return new Response("gone", { status: 404 });
      return Response.json({ current_page: [
        { event_ticker: "KXFEDDECISION-26DEC", event_title: "Fed decision in December?", event_subtitle: "On Dec 9, 2026", category: "Economics", recent_volume: 1229362, markets: [{ ticker: "H25", yes_subtitle: "Hike 25bps", last_price_dollars: "0.92", yes_bid_dollars: "0.91", yes_ask_dollars: "0.92", previous_price_dollars: "0.93", volume: 7_000_000, close_ts: "2026-12-09T18:59:00Z", result: "" }, { ticker: "OLD", yes_subtitle: "Settled", result: "no", volume: 9 }] },
        { event_ticker: "KXMVECROSS-1", event_title: "A parlay", recent_volume: 9e9, markets: [{ ticker: "KXMVECROSS-1-A", result: "" }] },
      ] });
    }
    if (u.hostname === "api.elections.kalshi.com" && u.pathname === "/trade-api/v2/events") return Response.json({ events: [{ event_ticker: "E1", title: "Fed funds rate after December meeting?", category: "Economics", markets: [{ ticker: "KXFED-26DEC-T4.00", yes_sub_title: "Above 4.00%", last_price_dollars: "0.98", volume_24h_fp: "4804", open_interest_fp: "9000" }] }] });
    if (u.hostname === "data-api.polymarket.com") return Response.json({ data: [
      { title: "Fed hikes 25 bps in December?", outcome: "Yes", current_size: 100, avg_price: 0.8, current_price: 0.915, current_value: 91.5, unrealized_pnl: 11.5, end_date: "2026-12-09" },
      { title: "Carney next PM?", outcome: "Yes", current_size: 10, current_value: 10, redeemable: true },
      { title: "Sold out", outcome: "No", current_size: 0 },
    ] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, urls };
}

test("prediction markets: the busiest on Polymarket and Kalshi, with odds, spreads, the day's move, volume and close", async () => {
  const { f } = fake();
  const t = await marketsText(undefined, f);
  assert.match(t, /Polymarket, busiest in the last 24h:\n- Fed hikes 25 bps in December\? · Yes 91\.5¢ \(bid 91\.0¢ \/ ask 92\.0¢\) · -1\.0¢ today · 24h volume \$316K · liquidity \$626K · ends Dec 9, 2026 · polymarket\.com\/event\/fed-december/);
  assert.match(t, /Kalshi, busiest in the last 24h:\n- Fed decision in December\? \(On Dec 9, 2026\) · Hike 25bps Yes 92\.0¢ \(bid 91\.0¢ \/ ask 92\.0¢\) -1\.0¢ · recent volume 1,229,362 contracts · closes Dec 9, 2026 · Economics · KXFEDDECISION-26DEC/);
  assert.doesNotMatch(t, /parlay|Settled/, "combo markets and settled ones are left out");
});

test("prediction markets: a topic searches both; Kalshi's site search failing falls back to its documented list", async () => {
  const { f, urls } = fake({ kalshiSearchDown: true });
  const t = await marketsText("fed", f);
  assert.ok(urls.some((u) => u.includes("public-search?q=fed")));
  assert.match(t, /Polymarket matching "fed":\n- Bitcoin above \$100k by Dec 31\? · Yes 12¢/);
  assert.doesNotMatch(t, /No prices yet/);
  assert.match(t, /Kalshi matching "fed":\n- Fed funds rate after December meeting\? — Above 4\.00% · Yes 98\.0¢/);
});

test("Phil's Polymarket bets from his public address; Cat has both tools, run up front on Grok", async () => {
  const { f } = fake();
  const t = await polyPositionsText({ label: "Main", address: "0x1111111111111111111111111111111111111111" }, f);
  assert.match(t, /^Main \(0x1111…1111\): 1 open position worth \$92, unrealized \+\$12\.\n- Fed hikes 25 bps in December\? · Yes · 100 shares @ 80¢ avg, now 91\.5¢ · worth \$92 \(\+\$12\) · ends Dec 9, 2026/);
  assert.match(t, /Resolved and waiting to be claimed \(\$10\): Carney next PM\? \(Yes, \$10\)\./);
  assert.doesNotMatch(t, /Sold out/);
  const store = memoryStore(); await store.init();
  assert.deepEqual(await polyAccounts(store, {}), []);
  const tool = PREDICTION_TOOLS.find((x) => x.name === "polymarket_positions")!;
  assert.match(await tool.handler({}, { store, agentId: "cat" }), /No Polymarket account set/);
  await store.settings.set(POLY_ACCOUNTS_KEY, [{ label: "Main", address: "0x1111111111111111111111111111111111111111" }]);
  for (const name of ["prediction_markets", "polymarket_positions"]) assert.ok(CHARTERS.cat!.tools!.includes(name), name);
  const real = globalThis.fetch; globalThis.fetch = f;
  try {
    const pre = await prefetchTools(PREDICTION_TOOLS, { store, agentId: "cat" });
    assert.match(pre, /### prediction_markets\nPrediction markets/);
    assert.match(pre, /### polymarket_positions\nMain \(0x1111…1111\): 1 open position/);
  } finally { globalThis.fetch = real; }
});
