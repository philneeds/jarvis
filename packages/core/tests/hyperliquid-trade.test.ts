import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, Jarvis, HyperliquidTrader, readOrder, CHARTERS, type HlExchange } from "../src/index.js";

const ACCT = "0x1111111111111111111111111111111111111111", AGENT = "0x2222222222222222222222222222222222222222";
function setup(opts: { account?: string; role?: { role: string; data?: { user: string } }; position?: string; open?: { coin: string; oid: number }[]; reply?: unknown } = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const real: HlExchange = {
    order: async (p) => { calls.push({ method: "order", args: p }); return (opts.reply ?? { response: { data: { statuses: [{ filled: { totalSz: p.orders[0]!.s, avgPx: "63200", oid: 77 } }] } } }) as never; },
    cancel: async (p) => { calls.push({ method: "cancel", args: p }); return {}; },
    updateLeverage: async (p) => { calls.push({ method: "updateLeverage", args: p }); return {}; },
  };
  // Anything else HQ might call on the exchange (a transfer, a withdrawal) is recorded and fails the test.
  const exchange = new Proxy(real, { get: (t, k) => (k in t ? t[k as keyof HlExchange] : () => { calls.push({ method: String(k), args: null }); throw new Error(`unexpected ${String(k)}`); }) }) as HlExchange;
  const f = (async (_u: string | URL | Request, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { type: string };
    if (b.type === "metaAndAssetCtxs") return Response.json([{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }, { name: "OLD", szDecimals: 0, maxLeverage: 3, isDelisted: true }] }, [{ markPx: "63196.5" }, { markPx: "1782.5" }, { markPx: "1" }]]);
    if (b.type === "userRole") return Response.json(opts.role ?? { role: "agent", data: { user: ACCT } });
    if (b.type === "clearinghouseState") return Response.json({ assetPositions: opts.position ? [{ position: { coin: "BTC", szi: opts.position } }] : [] });
    if (b.type === "openOrders") return Response.json(opts.open ?? []);
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  return { calls, exchange, f };
}
async function rig(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  const store = memoryStore(); await store.init();
  const trader = new HyperliquidTrader(store, { exchange: s.exchange, account: async () => opts.account, agentAddress: AGENT, fetch: s.f });
  const jarvis = new Jarvis({ store });
  jarvis.addConnector(trader, HyperliquidTrader.promptHint());
  const card = (payload: Record<string, unknown>) => jarvis.requestApproval({ agentId: "pentoshi", kind: "money", title: "Long BTC", body: "thesis", payload });
  return { ...s, store, trader, jarvis, card };
}

test("a Hyperliquid order waits for Phil, shows exactly what goes out, and runs only when he approves", async () => {
  const { calls, jarvis, card, store } = await rig();
  const c = await card({ action: "hyperliquid.order", coin: "btc", side: "long", usd: 500, leverage: 5 });
  assert.equal(c.status, "pending");
  assert.match(c.effect ?? "", /^Market BUY \(long\) about \$500 of BTC, filling within 2% of the mark or not at all, at 5x cross: margin about \$100\. Real money on your Hyperliquid account, the moment you approve\./);
  assert.equal(calls.length, 0, "nothing sent before approval");
  // Even an "approve everything" rule can't let a trade through.
  const { setAgentConfig } = await import("../src/index.js");
  await setAgentConfig(store, "pentoshi", { rules: { autoApprove: ["money", "other"], maxAutoDollars: 1e9 } } as never);
  // A different idea, so HQ's duplicate check (which folds a repeat of a waiting card into it) leaves both alone.
  const c2 = await jarvis.requestApproval({ agentId: "pentoshi", kind: "money", title: "Short ETH", body: "another idea", payload: { action: "hyperliquid.order", coin: "ETH", side: "sell", size: 0.01 } });
  assert.equal(c2.status, "pending", "trades never auto-approve");
  const done = await jarvis.decide(c.id, "approved");
  assert.deepEqual(calls.map((x) => x.method), ["updateLeverage", "order"], `note: ${done?.note} · status ${done?.status}`);
  assert.deepEqual(calls[0]!.args, { asset: 0, isCross: true, leverage: 5 });
  // $500 at mark 63,196.5 = 0.00791 BTC (5 decimals); an IOC limit 2% above the mark, 5 significant figures.
  assert.deepEqual(calls[1]!.args, { orders: [{ a: 0, b: true, p: "64460", s: "0.00791", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  assert.match(done?.note ?? "", /Hyperliquid: bought 0\.00791 BTC at 63,200 \(\$500\)\. Order 77\./);
});

test("refused before Phil sees it: a coin that doesn't trade, too much leverage, a broken card; limits only when he sets them", async () => {
  const { card, store, calls } = await rig();
  assert.equal((await card({ action: "hyperliquid.order", coin: "OLD", side: "buy", usd: 10 })).status, "rejected");
  const lev = await card({ action: "hyperliquid.order", coin: "ETH", side: "sell", usd: 100, leverage: 50 });
  assert.equal(lev.status, "rejected");
  assert.match(lev.note ?? "", /ETH allows up to 25x, not 50x/);
  assert.equal((await card({ action: "hyperliquid.order", coin: "ETH", side: "up", usd: 100 })).status, "rejected");
  // No limits by default (Phil, Nov 20): a big order still reaches him.
  assert.equal((await card({ action: "hyperliquid.order", coin: "BTC", side: "buy", usd: 50_000 })).status, "pending");
  await store.settings.set("hyperliquid.limits", { maxTradeUsd: 1000 });
  const big = await card({ action: "hyperliquid.order", coin: "BTC", side: "buy", usd: 5000 });
  assert.equal(big.status, "rejected");
  assert.match(big.note ?? "", /^refused: \$4,999 is over the \$1,000 per-trade limit\.$/);
  assert.equal(calls.length, 0);
});

test("close, cancel and leverage go through cards too; Hyperliquid refusing an order fails the card", async () => {
  const a = await rig({ position: "-0.02" });
  const close = await a.card({ action: "hyperliquid.close", coin: "BTC", pct: 50 });
  assert.equal(close.status, "pending");
  const done = await a.jarvis.decide(close.id, "approved");
  assert.deepEqual((a.calls[0]!.args as { orders: unknown[] }).orders[0], { a: 0, b: true, p: "64460", s: "0.01", r: true, t: { limit: { tif: "Ioc" } } }, "half the short, bought back reduce-only");
  assert.match(done?.note ?? "", /^Closed 50% of the BTC short\. Hyperliquid: bought 0\.01 BTC/);
  const b = await rig({ open: [{ coin: "BTC", oid: 5 }, { coin: "ETH", oid: 6 }, { coin: "BTC", oid: 7 }] });
  const cancel = await b.card({ action: "hyperliquid.cancel", coin: "BTC" });
  assert.match((await b.jarvis.decide(cancel.id, "approved"))?.note ?? "", /cancelled 2 BTC orders \(5, 7\)/);
  assert.deepEqual(b.calls[0]!.args, { cancels: [{ a: 0, o: 5 }, { a: 0, o: 7 }] });
  const c = await rig({ reply: { response: { data: { statuses: [{ error: "Insufficient margin to place order." }] } } } });
  const o = await c.card({ action: "hyperliquid.order", coin: "ETH", side: "buy", size: 1 });
  assert.match((await c.jarvis.decide(o.id, "approved"))?.note ?? "", /^Failed to execute hyperliquid\.order: Hyperliquid refused it: Insufficient margin/);
});

test("Hyperliquid itself says which account the key trades for: a main wallet's key, an unapproved key, or the wrong account is refused", async () => {
  const main = await rig({ role: { role: "user" } });
  const s = await main.trader.status();
  assert.equal(s.trading, false);
  assert.match(s.problem ?? "", /main wallet's own key \(it could withdraw\); use an API wallet's key/);
  const o = await main.card({ action: "hyperliquid.order", coin: "BTC", side: "buy", size: 0.001 });
  assert.match((await main.jarvis.decide(o.id, "approved"))?.note ?? "", /Failed to execute hyperliquid\.order: .*main wallet's own key/);
  assert.equal(main.calls.length, 0);
  const ok = await rig();
  assert.match(await ok.trader.tools()[0]!.handler({}, { store: ok.store, agentId: "pentoshi" }), /^Hyperliquid trading is on for 0x1111.*it can trade, not withdraw\)\. Limits: none per trade, none per day\./);
  assert.ok(CHARTERS.pentoshi!.tools!.includes("hyperliquid_trading"));
  assert.deepEqual(Object.keys(ok.trader.executors()).sort(), ["hyperliquid.cancel", "hyperliquid.close", "hyperliquid.leverage", "hyperliquid.order"]);
  assert.deepEqual(readOrder({ coin: "eth", side: "short", size: "2", price: "1900" }), { coin: "ETH", buy: false, size: 2, usd: undefined, price: 1900, market: false, reduceOnly: false, leverage: undefined, cross: true, slippagePct: 2 });
});

test("the account comes from Hyperliquid, not a guess; closing is never blocked by limits; limit prices go out exactly; close % is one rule", async () => {
  const unknown = await rig({ role: { role: "missing" } });
  assert.match((await unknown.trader.status()).problem ?? "", /doesn't know this key as an API wallet yet/);
  const other = await rig({ role: { role: "agent", data: { user: "0x9999999999999999999999999999999999999999" } }, account: ACCT });
  assert.match((await other.trader.status()).problem ?? "", /this API wallet trades for 0x9999.*not 0x1111/);
  const fine = await rig();
  const st = await fine.trader.status();
  assert.equal(st.trading, true);
  assert.equal(st.account, ACCT, "the owner Hyperliquid reports");
  // Limits cap new risk only: a close goes through, and isn't counted.
  const r = await rig({ position: "0.5" });
  await r.trader.setLimits({ maxTradeUsd: 100, maxDayUsd: 100 });
  const close = await r.card({ action: "hyperliquid.close", coin: "BTC" });
  assert.equal(close.status, "pending");
  assert.match((await r.jarvis.decide(close.id, "approved"))?.note ?? "", /^Closed the BTC long\. Hyperliquid: sold 0\.5 BTC/);
  assert.deepEqual(await r.store.settings.get("hyperliquid.spent", null), null);
  // A limit price that Hyperliquid's steps would change is refused, not quietly rounded.
  const lim = await fine.card({ action: "hyperliquid.order", coin: "BTC", side: "sell", size: 0.01, price: 97123.5 });
  assert.equal(lim.status, "rejected");
  assert.match(lim.note ?? "", /97,123\.5 would be sent as 97123; put 97123/);
  assert.equal((await fine.card({ action: "hyperliquid.order", coin: "BTC", side: "sell", size: 0.01, price: 97123 })).status, "pending");
  // The close card and the close agree on how much.
  const { closePct } = await import("../src/index.js");
  for (const [v, want] of [[-50, 100], [0.5, 1], [50, 50], [undefined, 100], [150, 100]] as const) assert.equal(closePct(v), want);
  const half = await rig({ position: "-0.02" });
  const c = await half.card({ action: "hyperliquid.close", coin: "BTC", pct: -50 });
  assert.match(c.effect ?? "", /^Closes your BTC position/, "-50 reads as the whole position, on the card and when it runs");
});
