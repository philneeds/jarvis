import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, Jarvis, HyperliquidTrader, readOrder, CHARTERS, type HlExchange } from "../src/index.js";

const ACCT = "0x1111111111111111111111111111111111111111", AGENT = "0x2222222222222222222222222222222222222222";
function setup(opts: { account?: string; role?: { role: string; data?: { user: string } }; position?: string; open?: { coin: string; oid: number }[]; reply?: unknown; pnl?: [number, string][]; openNtl?: string; resting?: { sz: string; limitPx: string; reduceOnly?: boolean }[] } = {}) {
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
    if (b.type === "clearinghouseState") return Response.json({ marginSummary: { totalNtlPos: opts.openNtl ?? "0" }, assetPositions: opts.position ? [{ position: { coin: "BTC", szi: opts.position } }] : [] });
    if (b.type === "portfolio") return opts.pnl ? Response.json([["day", { pnlHistory: opts.pnl }]]) : new Response("{}", { status: 500 });
    if (b.type === "openOrders") return Response.json(opts.open ?? []);
    if (b.type === "frontendOpenOrders") return Response.json(opts.resting ?? []);
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
  assert.match(await ok.trader.tools()[0]!.handler({}, { store: ok.store, agentId: "pentoshi" }), /^Hyperliquid trading is on for 0x1111.*it can trade, not withdraw\)\. Every order waits for Phil's card\. Caps: no per-trade cap, no daily cap\.\nPhil can let you trade on your own/);
  assert.ok(CHARTERS.pentoshi!.tools!.includes("hyperliquid_trading"));
  assert.deepEqual(Object.keys(ok.trader.executors()).sort(), ["hyperliquid.cancel", "hyperliquid.close", "hyperliquid.leverage", "hyperliquid.order", "hyperliquid.params"]);
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

test("an order under Hyperliquid's $10 minimum is refused before Phil sees it; a small close isn't", async () => {
  const { card } = await rig({ position: "0.0001" });
  const tiny = await card({ action: "hyperliquid.order", coin: "BTC", side: "buy", usd: 1 });
  assert.equal(tiny.status, "rejected");
  assert.ok((await card({ action: "hyperliquid.order", coin: "BTC", side: "buy", usd: 12 })).status === "pending");
  assert.equal((await card({ action: "hyperliquid.order", coin: "BTC", side: "sell", size: 0.0001, reduceOnly: true })).status, "pending");
});

test("Jarvis's rules know trades go through Pentoshi's cards, not that HQ can't trade", async () => {
  const { SAFETY_RULES, jarvisSystemPrompt } = await import("../src/index.js");
  assert.doesNotMatch(SAFETY_RULES, /no private keys in the system/);
  assert.match(SAFETY_RULES, /hyperliquid_trading/);
  assert.match(jarvisSystemPrompt([], "ok"), /perps trade on Hyperliquid[^\n]*delegate to pentoshi/);
});

const PARAMS = { auto: true, maxTradeUsd: 500, maxDayUsd: 2000, maxLeverage: 5, maxDayLossUsd: 200 };
const order = (o: Record<string, unknown> = {}) => ({ action: "hyperliquid.order", coin: "BTC", side: "buy", usd: 100, leverage: 3, ...o });

test("on his own: Pentoshi's order inside the parameters is placed at once and Phil is told; nobody else's is", async () => {
  const told: string[] = [];
  const s = await rig({ pnl: [[1, "0"], [2, "-50"]] });
  (s.jarvis as unknown as { notify: (t: string, b: string) => Promise<void> }).notify = async (t, b) => { told.push(`${t} | ${b}`); };
  await s.trader.setLimits(PARAMS);
  const a = await s.card(order());
  assert.equal(a.status, "approved");
  assert.match(a.note ?? "", /^auto: inside your Hyperliquid trading parameters · Hyperliquid: bought/);
  assert.equal(s.calls.filter((c) => c.method === "order").length, 1);
  assert.match(told.join("\n"), /Pentoshi: Long BTC \| Hyperliquid: bought/);
  // Another agent's identical card waits.
  const other = await s.jarvis.requestApproval({ agentId: "mantis", kind: "money", title: "Long BTC", body: "x", payload: order() });
  assert.equal(other.status, "pending");
  assert.equal(s.calls.filter((c) => c.method === "order").length, 1);
});

test("on his own: outside the parameters is a card that says why; over a hard cap is refused; risk-off always runs", async () => {
  const s = await rig({ pnl: [[1, "0"], [2, "-250"]], position: "0.01", openNtl: "900" });
  await s.trader.setLimits({ ...PARAMS, maxOpenUsd: 1000, coins: ["BTC", "ETH"] });
  const loss = await s.card(order({ usd: 50 }));
  assert.equal(loss.status, "pending");
  assert.match(loss.note ?? "", /Waits for you: not placed on his own: the account is down \$250 over the last 24 hours/);
  const s2 = await rig({ pnl: [[1, "0"], [2, "10"]], openNtl: "900" });
  await s2.trader.setLimits({ ...PARAMS, maxOpenUsd: 1000, coins: ["BTC", "ETH"] });
  assert.match((await s2.card(order({ usd: 200 }))).note ?? "", /over your \$1,000 cap/);
  assert.match((await s2.card(order({ coin: "SOL", usd: 20 }))).note ?? "", /isn't one of the coins|isn't a Hyperliquid perp/);
  assert.match((await s2.card(order({ usd: 20, leverage: undefined }))).note ?? "", /doesn't say its leverage/);
  assert.match((await s2.card(order({ usd: 20, leverage: 10 }))).note ?? "", /over your 5x leverage cap/);
  assert.equal((await s2.card(order({ usd: 900 }))).status, "rejected", "over the per-trade cap: refused, not a card");
  // A close goes through even past the loss stop.
  const close = await s.card({ action: "hyperliquid.close", coin: "BTC", pct: 100 });
  assert.equal(close.status, "approved");
  assert.ok(s.calls.some((c) => c.method === "order" && (c.args as { orders: { r: boolean }[] }).orders[0]!.r === true));
});

test("on his own needs every cap; PnL that can't be read means a card; parameter changes always wait for Phil", async () => {
  const s = await rig();
  await assert.rejects(s.trader.setLimits({ auto: true, maxTradeUsd: 100 }), /add a daily cap, a leverage cap, a daily loss stop/);
  assert.equal((await s.trader.limits()).auto, undefined, "nothing changed");
  await s.trader.setLimits(PARAMS);
  const blind = await s.card(order());
  assert.equal(blind.status, "pending");
  assert.match(blind.note ?? "", /PnL couldn't be read/);
  const ask = await s.jarvis.requestApproval({ agentId: "pentoshi", kind: "config", title: "Raise the per-trade cap", body: "why", payload: { action: "hyperliquid.params", maxTradeUsd: 1000 } });
  assert.equal(ask.status, "pending", "a parameter change waits");
  await s.jarvis.decide(ask.id, "approved");
  const l = await s.trader.limits();
  assert.equal(l.maxTradeUsd, 1000);
  assert.equal(l.auto, true, "what the card didn't name stays");
  assert.equal(l.maxLeverage, 5);
  // Switched off: back to cards.
  await s.trader.setLimits({ ...PARAMS, auto: false });
  assert.equal((await s.card(order())).status, "pending");
});

// From the review (Nov 21): ways placing alone let more risk through than the caps, and their fixes.
const sent = (calls: { method: string; args: unknown }[]) => calls.filter((c) => c.method === "order").map((c) => (c.args as { orders: { s: string; p: string; r: boolean }[] }).orders[0]!);

test("review: a reduce-only order never changes leverage; a far-off limit sell is sized at the mark; a market order ignores a price", async () => {
  const s = await rig({ pnl: [[1, "0"], [2, "0"]], position: "0.5" });
  await s.trader.setLimits({ ...PARAMS, coins: ["ETH", "BTC"] });
  const a = await s.card(order({ side: "sell", size: 0.0002, reduceOnly: true, leverage: 40, cross: false }));
  assert.equal(a.status, "approved");
  assert.ok(!s.calls.some((c) => c.method === "updateLeverage"), "no leverage change from a reduce-only order");
  // $499 sell limited at a quarter of the mark (63,196): sized at the mark, so about $499, not ~$2,000.
  const far = await s.card(order({ side: "sell", type: "limit", price: 15800, usd: 499, leverage: 5 }));
  assert.equal(far.status, "approved");
  const o = sent(s.calls).at(-1)!;
  assert.ok(Number(o.s) * 63196.5 <= 500, `size ${o.s} is worth no more than the cap`);
  // A market order with a stray price is sized at the mark.
  const s2 = await rig();
  const m = await s2.card(order({ type: "market", usd: 100, price: 100, leverage: undefined }));
  await s2.jarvis.decide(m.id, "approved");
  assert.ok(Number(sent(s2.calls)[0]!.s) < 0.01, "about $100 of BTC, not 1 BTC");
});

test("review: resting orders count toward the open cap; Phil's pause stops it; a cancel alone only touches HQ's own orders", async () => {
  const s = await rig({ pnl: [[1, "0"], [2, "0"]], resting: [{ sz: "0.008", limitPx: "60000" }], open: [{ coin: "BTC", oid: 9 }] });
  await s.trader.setLimits({ ...PARAMS, maxOpenUsd: 600 });
  assert.match((await s.card(order({ usd: 200 }))).note ?? "", /open positions and resting orders to \$680/);
  const c = await s.card({ action: "hyperliquid.cancel", coin: "BTC" });
  assert.equal(c.status, "pending");
  assert.match(c.note ?? "", /order 9 on BTC weren't placed by HQ/);
  await s.store.settings.set("killSwitch", { all: false, trading: true, agents: [] });
  const paused = await s.card({ action: "hyperliquid.close", coin: "BTC", pct: 100 });
  assert.equal(paused.status, "pending");
  assert.match(paused.note ?? "", /trading is paused/);
});

test("review: $10 is enough; parameters are read strictly; a card the last check stops goes back to Phil; Phil is told once", async () => {
  const told: string[] = [];
  const s = await rig({ pnl: [[1, "0"], [2, "0"]] });
  (s.jarvis as unknown as { notify: (t: string, b: string) => Promise<void> }).notify = async (t, b) => { told.push(b); };
  await s.trader.setLimits({ ...PARAMS, maxTradeUsd: "1,000" as unknown as number });
  assert.equal((await s.trader.limits()).maxTradeUsd, 1000);
  await assert.rejects(s.trader.setLimits({ ...PARAMS, maxTradeUsd: "lots" as unknown as number }), /must be a number/);
  await assert.rejects(s.trader.setLimits({ ...PARAMS, auto: "yes" as unknown as boolean }), /true or false/);
  await s.trader.setLimits({ ...PARAMS, maxLeverage: 5.6 });
  assert.equal((await s.trader.limits()).maxLeverage, 5, "rounded down");
  const ten = await s.card(order({ usd: 10 }));
  assert.equal(ten.status, "approved", ten.note);
  assert.equal(told.length, 1);
  assert.equal((told[0]!.match(/Hyperliquid: bought/g) ?? []).length, 1, "the fill once, not twice");
  // The check passes when filed, but by the time it goes out Phil paused trading: back to him, pending.
  const t = s.trader as unknown as { autoRefusal: (a: unknown) => Promise<string | undefined> };
  const real = t.autoRefusal.bind(s.trader);
  let first = true;
  t.autoRefusal = async (a) => (first ? ((first = false), real(a)) : "trading is paused");
  const late = await s.card(order({ usd: 20 }));
  assert.equal(late.status, "pending");
  assert.match(late.note ?? "", /^Waits for you: not placed on his own: trading is paused\.$/);
  assert.equal((await s.store.approvals.get(late.id))?.status, "pending");
});
