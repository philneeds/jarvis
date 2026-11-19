import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, lighterPerps, lighterText, lighterAccountText, lighterAccounts, LIGHTER_ACCOUNTS_KEY, LIGHTER_TOOLS, CHARTERS, prefetchTools } from "../src/index.js";

const ADDR = "0x29D4Ad2Fca00f33a30887449c9FA060e57D6fD1B";
const f = (async (url: string | URL | Request) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith("/orderBookDetails")) return Response.json({ code: 200, order_book_details: [
    { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", last_trade_price: 63196.5, daily_price_change: 0.02, daily_quote_token_volume: 1.14e9, open_interest_usd: 270.6e6 },
    { symbol: "ETH", market_id: 0, market_type: "perp", status: "active", last_trade_price: 1782.54, daily_price_change: 0.7, daily_quote_token_volume: 325e6, open_interest_usd: 137e6 },
    { symbol: "OLD", market_id: 9, market_type: "perp", status: "inactive", last_trade_price: 1 },
  ] });
  if (u.pathname.endsWith("/funding-rates")) return Response.json({ code: 200, funding_rates: [
    { market_id: 1, exchange: "lighter", symbol: "BTC", rate: 0.000096 }, { market_id: 1, exchange: "hyperliquid", symbol: "BTC", rate: 0.0001 }, { market_id: 1, exchange: "binance", symbol: "BTC", rate: 0.0000654 },
    { market_id: 0, exchange: "lighter", symbol: "ETH", rate: 0.000024 }, { market_id: 0, exchange: "bybit", symbol: "ETH", rate: 0.0005 },
  ] });
  if (u.pathname.endsWith("/account")) {
    if (u.searchParams.get("value") !== ADDR) return Response.json({ code: 21100, message: "account not found" }, { status: 400 });
    return Response.json({ code: 200, accounts: [{ index: 768415, account_type: 0, collateral: "150.56", available_balance: "72", total_asset_value: "891", positions: [
      { symbol: "ETH", sign: -1, position: "23.0000", avg_entry_price: "1780.96", position_value: "40983.55", unrealized_pnl: "-6.2", liquidation_price: "1795.94", initial_margin_fraction: "2.00", margin_mode: 1, total_funding_paid_out: "0" },
      { symbol: "BTC", sign: 1, position: "0.1", avg_entry_price: "60000", position_value: "6319.65", unrealized_pnl: "319.65", liquidation_price: "0", initial_margin_fraction: "10.00", margin_mode: 0, total_funding_paid_out: "1.5", open_order_count: 2 },
      { symbol: "SOL", sign: 1, position: "0" },
    ] }] });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

test("Lighter markets: funding hourly and APR from the 8-hour feed, OI, moves, and other venues side by side", async () => {
  const rows = await lighterPerps(f);
  assert.deepEqual(rows.map((r) => r.coin), ["BTC", "ETH"], "an inactive market is left out");
  const all = lighterText(rows);
  assert.match(all, /Biggest open interest:\nBTC: 63,196\.5 \(\+0\.0% 24h\) · funding \+0\.0012%\/h \(\+11% APR\) · OI \$270\.6M · 24h volume \$1\.14B/);
  assert.match(all, /Widest funding gaps against other venues \(per 8h\):\nETH: Lighter \+0\.0024% vs bybit \+0\.0500%/);
  const two = lighterText(rows, ["btc", "XYZ"]);
  assert.match(two, /BTC: .*\n  funding per 8h: Lighter \+0\.0096% · Hyperliquid \+0\.0100% · Binance \+0\.0065%/);
  assert.match(two, /Not listed on Lighter: XYZ\./);
});

test("Phil's Lighter account by its public address: positions with leverage and liquidation distance, closest first", async () => {
  const t = await lighterAccountText({ label: "Main", address: ADDR }, f);
  assert.match(t, /^Main \(0x29D4…fD1B\): worth \$891, available \$72, open positions \$47,303 \(53\.1x\)\.\n- ⚠ CLOSE TO LIQUIDATION · ETH short 23 @ 1,780\.96 · mark 1,781\.89 · \$40,984 · uPnL -\$6 · 50x isolated · liquidation 1,795\.94 \(0\.8% away\)/);
  assert.match(t, /- BTC long 0\.1 @ 60,000 · mark 63,196\.5 · \$6,320 · uPnL \+\$320 · 10x cross · no liquidation price · funding paid \$2 · 2 open orders/);
  assert.doesNotMatch(t, /SOL/);
  assert.equal(await lighterAccountText({ label: "X", address: "0x0000000000000000000000000000000000000002" }, f), "X (0x0000…0002): no Lighter account at this address.");
});

test("Pentoshi has the Lighter tools, and on Grok gets them run up front", async () => {
  const store = memoryStore(); await store.init();
  assert.deepEqual(await lighterAccounts(store, {}), []);
  for (const n of ["lighter_perps", "lighter_account"]) assert.ok(CHARTERS.pentoshi!.tools!.includes(n), n);
  const acct = LIGHTER_TOOLS.find((x) => x.name === "lighter_account")!;
  assert.match(await acct.handler({}, { store, agentId: "pentoshi" }), /No Lighter account set/);
  await store.settings.set(LIGHTER_ACCOUNTS_KEY, [{ label: "Main", address: ADDR }]);
  const real = globalThis.fetch; globalThis.fetch = f;
  try {
    const pre = await prefetchTools(LIGHTER_TOOLS, { store, agentId: "pentoshi" });
    assert.match(pre, /### lighter_perps\nLighter perps \(2 markets/);
    assert.match(pre, /### lighter_account\nMain \(0x29D4…fD1B\): worth \$891/);
  } finally { globalThis.fetch = real; }
});
