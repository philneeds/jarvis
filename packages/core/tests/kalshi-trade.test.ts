import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { memoryStore, Jarvis, KalshiTrader, readKalshiOrder, snapPrice, CHARTERS, alwaysWaits } from "../src/index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** A stand-in Kalshi: one market, an account, and a record of every request with whether its signature was good. */
function setup(opts: { yesBid?: string; yesAsk?: string; status?: string; position?: string; exposure?: string; resting?: { order_id: string; ticker: string; outcome_side: "yes" | "no"; yes_price_dollars: string; no_price_dollars: string; remaining_count_fp: string }[]; fill?: (body: Record<string, unknown>) => Record<string, unknown>; ranges?: { start: string; end: string; step: string }[]; reject?: { status: number; body: unknown }; postFails?: () => Response | undefined; listed?: Record<string, unknown>[]; pages?: Record<string, unknown>[][]; marketType?: string; balanceFails?: { n: number } } = {}) {
  const calls: { method: string; path: string; body?: Record<string, unknown>; signed: boolean }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const method = init?.method ?? "GET";
    const h = init?.headers as Record<string, string>;
    const signed = verify("sha256", Buffer.from(`${h["KALSHI-ACCESS-TIMESTAMP"]}${method}${u.pathname}`), { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"]!, "base64")) && h["KALSHI-ACCESS-KEY"] === "key-1";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: u.pathname.replace("/trade-api/v2", "") + u.search, body, signed });
    const p = u.pathname.replace("/trade-api/v2", "");
    if (opts.reject && p === "/portfolio/balance") return Response.json(opts.reject.body, { status: opts.reject.status });
    if (opts.balanceFails && p === "/portfolio/balance" && opts.balanceFails.n-- > 0) return Response.json({ error: { code: "too_many_requests" } }, { status: 429 });
    if (p === "/portfolio/balance") return Response.json({ balance: 50_000, balance_dollars: "500.0000", portfolio_value: 12_000, updated_ts: 1 });
    if (p.startsWith("/markets/")) return p.endsWith("/NOPE") ? Response.json({ error: { code: "not_found" } }, { status: 404 }) : Response.json({ market: { ticker: "FED-26DEC-CUT", title: "Fed cuts in December?", status: opts.status ?? "active", market_type: opts.marketType ?? "binary", yes_bid_dollars: opts.yesBid ?? "0.5500", yes_ask_dollars: opts.yesAsk ?? "0.5600", price_ranges: opts.ranges ?? [{ start: "0.0000", end: "1.0000", step: "0.0100" }] } });
    if (p === "/portfolio/positions" && opts.pages) { const i = Number(u.searchParams.get("cursor") ?? 0); return Response.json({ market_positions: opts.pages[i] ?? [], cursor: i + 1 < opts.pages.length ? String(i + 1) : "" }); }
    if (p === "/portfolio/positions") return Response.json({ market_positions: opts.position ? [{ ticker: "FED-26DEC-CUT", position_fp: opts.position, market_exposure_dollars: opts.exposure ?? "0.0000" }] : [], event_positions: [] });
    if (p === "/portfolio/orders" && !u.searchParams.get("status")) return Response.json({ orders: opts.listed ?? [], cursor: "" });
    if (p === "/portfolio/orders") return Response.json({ orders: opts.resting ?? [], cursor: "" });
    if (p === "/portfolio/events/orders" && method === "POST" && opts.postFails) { const r = opts.postFails(); if (r) return r; }
    if (p === "/portfolio/events/orders" && method === "POST") return Response.json({ order_id: `ord-${calls.length}`, ts_ms: 1, ...(opts.fill ? opts.fill(body!) : { fill_count: "0.00", remaining_count: body!.count }) }, { status: 201 });
    if (p.startsWith("/portfolio/events/orders/") && method === "DELETE") return Response.json({ order_id: p.split("/").pop(), reduced_by: "10.00", ts_ms: 1 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, f };
}
async function rig(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  const store = memoryStore(); await store.init();
  const trader = new KalshiTrader(store, { keyId: "key-1", key: privateKey, fetch: s.f, retryMs: 1 });
  const jarvis = new Jarvis({ store });
  jarvis.addConnector(trader, KalshiTrader.promptHint());
  const card = (payload: Record<string, unknown>, agentId = "cat") => jarvis.requestApproval({ agentId, kind: "money", title: "Buy 10 YES FED-26DEC-CUT", body: "thesis", payload });
  const orders = () => s.calls.filter((c) => c.method === "POST" && c.path === "/portfolio/events/orders").map((c) => c.body!);
  return { ...s, store, trader, jarvis, card, orders };
}
const PARAMS = { auto: true, maxOrderUsd: 50, maxDayUsd: 200, maxOpenUsd: 300 };
const buy = (o: Record<string, unknown> = {}) => ({ action: "kalshi.order", ticker: "fed-26dec-cut", side: "yes", count: 10, price: 0.56, ...o });

test("a Kalshi order waits for Phil, is signed the way Kalshi asks, and goes out in the YES book's terms", async () => {
  const { calls, jarvis, card, orders, trader } = await rig();
  assert.equal((await trader.status()).trading, true);
  const c = await card(buy());
  assert.equal(c.status, "pending", "nothing auto-approves by default");
  assert.equal(alwaysWaits({ kind: "other", payload: { action: "kalshi.order" } }), true, "no rule of Phil's can let it through");
  assert.match(c.effect ?? "", /^Buys 10 YES contracts on FED-26DEC-CUT at 56¢ each, resting until filled or cancelled\. Costs \$5\.60 at most plus Kalshi's fee \(about \$0\.20\), which together is the most it can lose; pays \$10 if YES wins\. Real money/);
  assert.equal(orders().length, 0);
  const done = await jarvis.decide(c.id, "approved");
  assert.deepEqual({ ...orders()[0], client_order_id: undefined }, { ticker: "FED-26DEC-CUT", side: "bid", count: "10.00", price: "0.5600", time_in_force: "good_till_canceled", self_trade_prevention_type: "taker_at_cross", client_order_id: undefined });
  assert.match(done?.note ?? "", /Kalshi: order for YES on FED-26DEC-CUT: 10 resting at 56¢ \(order ord-/);
  assert.ok(calls.length > 0 && calls.every((x) => x.signed), "every request carries the key id and an RSA-PSS signature over timestamp + method + path");
  // Buying NO at 44¢ is selling YES at 56¢ on the one book.
  const no = await card(buy({ side: "no", price: 44 }));
  await jarvis.decide(no.id, "approved");
  assert.deepEqual([orders()[1]!.side, orders()[1]!.price], ["ask", "0.5600"]);
  assert.ok(CHARTERS.cat!.tools!.includes("kalshi_trading") && CHARTERS.cat!.tools!.includes("kalshi_account"));
  assert.deepEqual(Object.keys(trader.executors()).sort(), ["kalshi.cancel", "kalshi.close", "kalshi.order", "kalshi.params"], "nothing that moves money out");
});

test("a market order is an immediate-or-cancel limit just past the offer, and reports what filled and at what", async () => {
  const { jarvis, card, orders } = await rig({ fill: (b) => ({ fill_count: "6.00", remaining_count: "0.00", average_fee_paid: "0.0200", average_fill_price: b.side === "bid" ? "0.5700" : "0.5400" }) });
  const m = await card(buy({ type: "market", price: undefined }));
  const done = await jarvis.decide(m.id, "approved");
  assert.deepEqual([orders()[0]!.side, orders()[0]!.price, orders()[0]!.time_in_force], ["bid", "0.5800", "immediate_or_cancel"], "the 56¢ offer plus 2¢");
  assert.match(done?.note ?? "", /Kalshi: bought 6 YES on FED-26DEC-CUT at 57¢ \(\$3\.42 plus \$0\.12 in fees\); 4 of the 10 didn't fill within 2¢ of the offer and were cancelled\./);
  // NO at market: the NO offer is 1 − the YES bid (45¢); 2¢ past it is 47¢, sent as selling YES at 53¢. A fill at 54¢ YES is 46¢ NO.
  const n = await card(buy({ side: "no", type: "market", price: undefined }));
  const done2 = await jarvis.decide(n.id, "approved");
  assert.deepEqual([orders()[1]!.side, orders()[1]!.price], ["ask", "0.5300"]);
  assert.match(done2?.note ?? "", /bought 6 NO on FED-26DEC-CUT at 46¢ \(\$2\.76 plus/);
});

test("refused before Phil sees it: a market that doesn't exist or isn't trading, a price off the grid, a broken card, over a cap", async () => {
  const { card, trader } = await rig({ ranges: [{ start: "0.0000", end: "0.1000", step: "0.0010" }, { start: "0.1000", end: "0.9000", step: "0.0100" }, { start: "0.9000", end: "1.0000", step: "0.0010" }] });
  assert.equal((await card(buy({ ticker: "NOPE" }))).status, "rejected");
  const off = await card(buy({ price: 0.565 }));
  assert.equal(off.status, "rejected");
  assert.match(off.note ?? "", /prices go in steps: 56\.5¢ isn't one; the nearest is 5[67]¢/);
  assert.equal((await card(buy({ price: 0.905 }))).status, "pending", "half a cent is a tick near the edges of this market");
  assert.equal((await card(buy({ side: "maybe" }))).status, "rejected");
  assert.equal((await card(buy({ count: 2.5 }))).status, "rejected");
  assert.equal((await card(buy({ count: 1000 }))).status, "pending", "no cap until Phil sets one");
  await trader.setLimits({ maxOrderUsd: 50, maxDayUsd: 200 });
  const big = await card(buy({ count: 100 }));
  assert.equal(big.status, "rejected");
  assert.match(big.note ?? "", /\$58 \(with Kalshi's fee\) is over the \$50 per-order cap/);
  const closed = await rig({ status: "closed" });
  assert.match((await closed.card(buy())).note ?? "", /isn't trading \(it is closed\)/);
  assert.deepEqual(readKalshiOrder({ ticker: "x", side: "NO", count: "3", price: "44¢" }), { ticker: "X", side: "no", count: 3, price: 0.44, market: false, slippage: 0.02 });
  assert.equal(snapPrice(0.0514, [{ start: "0.0000", end: "0.1000", step: "0.0010" }], "up"), 0.052);
});

test("on her own: Cat's order inside the caps is placed at once and Phil is told; outside them it waits and says why; nobody else's runs", async () => {
  const told: string[] = [];
  const s = await rig({ position: "100.00", exposure: "280.0000" });
  (s.jarvis as unknown as { notify: (t: string, b: string) => Promise<void> }).notify = async (t, b) => { told.push(`${t} | ${b}`); };
  await assert.rejects(s.trader.setLimits({ auto: true, maxOrderUsd: 50 }), /add a daily cap, a cap on everything open/);
  await s.trader.setLimits(PARAMS);
  const ok = await s.card(buy());
  assert.equal(ok.status, "approved");
  assert.match(ok.note ?? "", /^auto: inside your Kalshi trading parameters · Kalshi: order for YES/);
  assert.match(told.join("\n"), /Cat: Buy 10 YES FED-26DEC-CUT \| Kalshi: order for YES/);
  // $280 already open: another $28 would pass the $300 cap, so it's Phil's call.
  const over = await s.card(buy({ count: 50 }));
  assert.equal(over.status, "pending");
  assert.match(over.note ?? "", /Waits for you: not placed on its own: it would take everything open to \$314\.80, over your \$300 cap/);
  assert.equal((await s.card(buy(), "mantis")).status, "pending", "only Cat trades on her own");
  // Phil's pause stops it.
  await s.store.settings.set("killSwitch", { all: false, trading: true, agents: [] });
  assert.match((await s.card(buy({ count: 1 }))).note ?? "", /trading is paused/);
  await s.store.settings.set("killSwitch", { all: false, trading: false, agents: [] });
  // A parameter change always waits, and changes only what it names.
  const ask = await s.jarvis.requestApproval({ agentId: "cat", kind: "config", title: "Raise the daily cap", body: "why", payload: { action: "kalshi.params", maxDayUsd: 500 } });
  assert.equal(ask.status, "pending");
  await s.jarvis.decide(ask.id, "approved");
  assert.deepEqual(await s.trader.limits(), { auto: true, maxOrderUsd: 50, maxDayUsd: 500, maxOpenUsd: 300 });
});

test("closing sells into the bids, reduce-only; a cancel on her own only touches orders HQ placed", async () => {
  const yes = await rig({ position: "40.00", fill: () => ({ fill_count: "20.00", remaining_count: "0.00", average_fill_price: "0.5400" }) });
  const c = await yes.card({ action: "kalshi.close", ticker: "FED-26DEC-CUT", pct: 50 });
  const done = await yes.jarvis.decide(c.id, "approved");
  assert.deepEqual({ ...yes.orders()[0], client_order_id: undefined }, { ticker: "FED-26DEC-CUT", side: "ask", count: "20.00", price: "0.5300", time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross", reduce_only: true, client_order_id: undefined });
  assert.match(done?.note ?? "", /Kalshi: sold 20 YES on FED-26DEC-CUT at 54¢ \(\$10\.80 back\), 50% of the position\./);
  // Holding NO: buy YES back from the offers, which nets the NO away.
  const no = await rig({ position: "-10.00", fill: () => ({ fill_count: "10.00", remaining_count: "0.00", average_fill_price: "0.5700" }) });
  const c2 = await no.card({ action: "kalshi.close", ticker: "FED-26DEC-CUT" });
  assert.match((await no.jarvis.decide(c2.id, "approved"))?.note ?? "", /sold 10 NO on FED-26DEC-CUT at 43¢/);
  assert.deepEqual([no.orders()[0]!.side, no.orders()[0]!.price, no.orders()[0]!.reduce_only], ["bid", "0.5800", true]);
  const none = await rig();
  const c3 = await none.card({ action: "kalshi.close", ticker: "FED-26DEC-CUT" });
  assert.match((await none.jarvis.decide(c3.id, "approved"))?.note ?? "", /Failed to execute kalshi\.close: there's no open position/);
  // An order Phil placed by hand is resting: on her own, Cat can't cancel it.
  const theirs = await rig({ resting: [{ order_id: "phils", ticker: "FED-26DEC-CUT", outcome_side: "yes", yes_price_dollars: "0.4000", no_price_dollars: "0.6000", remaining_count_fp: "5.00" }] });
  await theirs.trader.setLimits(PARAMS);
  const x = await theirs.card({ action: "kalshi.cancel", ticker: "FED-26DEC-CUT" });
  assert.equal(x.status, "pending");
  assert.match(x.note ?? "", /an order there weren't placed by HQ/);
  await theirs.jarvis.decide(x.id, "approved");
  assert.ok(theirs.calls.some((k) => k.method === "DELETE" && k.path === "/portfolio/events/orders/phils?market_ticker=FED-26DEC-CUT"), "with Phil's approval it goes");
});

test("a key Kalshi refuses, or one without the trade permission, is said plainly and trading stays off", async () => {
  const bad = await rig({ reject: { status: 401, body: { error: { code: "authentication_error", details: "invalid signature" } } } });
  const s = await bad.trader.status();
  assert.equal(s.trading, false);
  assert.match(s.problem ?? "", /Kalshi refused the key \(authentication_error: invalid signature\)/);
  assert.match(await bad.trader.tools()[0]!.handler({}, { store: bad.store, agentId: "cat" }), /^Kalshi trading is off: Kalshi refused the key/);
  const scope = await rig({ reject: { status: 403, body: { error: { code: "insufficient_scope:_read::portfolio_balance_required" } } } });
  assert.match((await scope.trader.status()).problem ?? "", /lacks the "read::portfolio_balance" permission/);
  const ok = await rig({ position: "10.00", exposure: "5.6000" });
  assert.match(await ok.trader.tools()[0]!.handler({}, { store: ok.store, agentId: "cat" }), /^Kalshi trading is on: \$500 cash, positions worth \$120\. Every order waits for Phil's card\./);
  assert.match(await ok.trader.tools()[1]!.handler({}, { store: ok.store, agentId: "cat" }), /Positions \(1\):\n- FED-26DEC-CUT: 10 YES, cost \$5\.60/);
});

// From the review (Nov 23), before anyone traded: each of these was a real hole.
const sold = (b: Record<string, unknown>) => ({ fill_count: b.count, remaining_count: "0.00", average_fill_price: b.price });

test("review: an order Kalshi didn't answer for is looked up by its id; if it still can't be found, Phil is told it may have gone out and it counts against the day", async () => {
  // The POST gets a 503, but the order is there when HQ looks: it is reported as placed and remembered as HQ's.
  let cid = "";
  const found = await rig({ postFails: () => Response.json({ error: { code: "service_unavailable" } }, { status: 503 }), listed: [] });
  const c = await found.card(buy());
  const wrapped = found.f;
  (found.trader as unknown as { opts: { fetch: typeof fetch } }).opts.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (init?.method === "POST") cid = (JSON.parse(String(init.body)) as { client_order_id: string }).client_order_id;
    if (u.pathname.endsWith("/portfolio/orders") && !u.searchParams.get("status")) return Response.json({ orders: [{ order_id: "ord-late", client_order_id: cid, ticker: "FED-26DEC-CUT", fill_count_fp: "0.00", remaining_count_fp: "10.00" }], cursor: "" });
    return wrapped(url, init);
  }) as typeof fetch;
  assert.match((await found.jarvis.decide(c.id, "approved"))?.note ?? "", /Kalshi: order for YES on FED-26DEC-CUT: 10 resting at 56¢ \(order ord-late\)/);
  assert.match(cid, /^hq-[0-9a-f-]{36}-[0-9a-f]{8}$/);
  // Nowhere to be found: not "failed", but "may have gone out", and the day's count has it.
  const lost = await rig({ postFails: () => new Response("upstream timeout", { status: 503 }) });
  const c2 = await lost.card(buy());
  assert.match((await lost.jarvis.decide(c2.id, "approved"))?.note ?? "", /Failed to execute kalshi\.order: Kalshi answered 503\. The order for 10 YES on FED-26DEC-CUT MAY have gone out: check kalshi_account before trying again\. It is counted against today's cap/);
  assert.equal((await lost.store.settings.get<{ usd: number }>("kalshi.spent", { usd: 0 })).usd, 5.8);
});

test("review: buying the other side of a position held is refused (it would sell the position), and only yes/no markets trade", async () => {
  const yes = await rig({ position: "10.00" });
  const no = await yes.card(buy({ side: "no", price: 0.44 }));
  assert.equal(no.status, "rejected");
  assert.match(no.note ?? "", /you hold 10 YES on FED-26DEC-CUT: buying NO there would sell that YES rather than open a new position\. Close it first/);
  assert.equal((await yes.card(buy())).status, "pending", "adding to the side held is fine");
  const scalar = await rig({ marketType: "scalar" });
  assert.match((await scalar.card(buy())).note ?? "", /is a scalar market/);
});

test("review: the open cap reads every page; a type that isn't limit or market is refused; a market order carries no price", async () => {
  // 200 flat rows used to fill the first page and hide the $290 position on the second.
  const s = await rig({ pages: [Array.from({ length: 3 }, (_, i) => ({ ticker: `OLD-${i}`, position_fp: "0.00", market_exposure_dollars: "0.0000" })), [{ ticker: "OTHER", position_fp: "500.00", market_exposure_dollars: "290.0000" }]] });
  await s.trader.setLimits(PARAMS);
  const over = await s.card(buy({ count: 50 }));
  assert.equal(over.status, "pending");
  assert.match(over.note ?? "", /it would take everything open to \$319, over your \$300 cap/);
  assert.ok(s.calls.some((c) => /count_filter=position/.test(c.path) && /cursor=1/.test(c.path)), "the second page was read, with the position filter");
  for (const type of ["gtc", "limit order", "ioc"]) assert.equal((await s.card(buy({ type }))).status, "rejected", type);
  assert.match((await s.card(buy({ type: "market" }))).note ?? "", /a market order has no price/);
});

test("review: a nearly worthless position still closes (never at 0 or 1); a fraction of a contract closes whole; a bad pct is refused", async () => {
  const dust = await rig({ position: "2.50", yesBid: "0.0100", yesAsk: "0.0200", fill: sold });
  const c = await dust.card({ action: "kalshi.close", ticker: "FED-26DEC-CUT" });
  const done = await dust.jarvis.decide(c.id, "approved");
  assert.deepEqual([dust.orders()[0]!.price, dust.orders()[0]!.count], ["0.0100", "2.50"], "the lowest tick, and all 2.5 contracts");
  assert.match(done?.note ?? "", /sold 2\.5 YES on FED-26DEC-CUT at 1¢/);
  const top = await rig({ position: "-4.00", yesBid: "0.9800", yesAsk: "0.9900", fill: sold });
  const c2 = await top.card({ action: "kalshi.close", ticker: "FED-26DEC-CUT" });
  await top.jarvis.decide(c2.id, "approved");
  assert.equal(top.orders()[0]!.price, "0.9900", "the highest tick, not 1.0000");
  for (const pct of ["50%", 0.25, "half"]) assert.equal((await top.card({ action: "kalshi.close", ticker: "FED-26DEC-CUT", pct })).status, "rejected", String(pct));
});

test("review: one rate-limited balance call doesn't switch trading off; closing on her own is only for positions HQ opened", async () => {
  const s = await rig({ position: "10.00", balanceFails: { n: 1 }, fill: sold });
  assert.equal((await s.trader.status()).trading, false, "this call hit the limit");
  const c = await s.card({ action: "kalshi.close", ticker: "FED-26DEC-CUT" });
  assert.match((await s.jarvis.decide(c.id, "approved"))?.note ?? "", /Kalshi: sold 10 YES/, "and the close right after still went through");
  // Phil opened this one by hand: on her own Cat can't sell it.
  const mine = await rig({ position: "10.00", fill: sold });
  await mine.trader.setLimits(PARAMS);
  const x = await mine.card({ action: "kalshi.close", ticker: "FED-26DEC-CUT" });
  assert.equal(x.status, "pending");
  assert.match(x.note ?? "", /the position on FED-26DEC-CUT wasn't opened by HQ \(yours, by hand\?\), so closing it is your call/);
  // One HQ bought into closes on her own.
  await mine.store.settings.set("kalshi.ourTickers", ["FED-26DEC-CUT"]);
  assert.equal((await mine.card({ action: "kalshi.close", ticker: "FED-26DEC-CUT", pct: 50 })).status, "approved");
});

test("review: two orders on one card get different ids; a cancelled order gives its count back; a cap under $1 is refused, not read as none", async () => {
  const s = await rig();
  const batch = await s.jarvis.requestApproval({ agentId: "cat", kind: "money", title: "Two bids", body: "why", payload: { action: "batch", steps: [buy({ price: 0.5 }), buy({ price: 0.4 })] } });
  await s.jarvis.decide(batch.id, "approved");
  const ids = s.orders().map((o) => o.client_order_id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  // $5 + $4 resting plus fees are counted; cancelling one (Kalshi says 10 contracts came off) gives its part back.
  const before = (await s.store.settings.get<{ usd: number }>("kalshi.spent", { usd: 0 })).usd;
  assert.equal(before, 9.4);
  const ours = await s.store.settings.get<{ id: string }[]>("kalshi.ourOrders", []);
  const one = { order_id: ours[0]!.id, ticker: "FED-26DEC-CUT", outcome_side: "yes" as const, yes_price_dollars: "0.5000", no_price_dollars: "0.5000", remaining_count_fp: "10.00" };
  const wrapped = s.f;
  (s.trader as unknown as { opts: { fetch: typeof fetch } }).opts.fetch = (async (url: string | URL | Request, init?: RequestInit) => (new URL(String(url)).searchParams.get("status") === "resting" ? Response.json({ orders: [one], cursor: "" }) : wrapped(url, init))) as typeof fetch;
  const x = await s.card({ action: "kalshi.cancel", ticker: "FED-26DEC-CUT" });
  await s.jarvis.decide(x.id, "approved");
  assert.equal((await s.store.settings.get<{ usd: number }>("kalshi.spent", { usd: 0 })).usd, 4.2, "the 50¢ order's $5.20 came back");
  await assert.rejects(s.trader.setLimits({ maxOrderUsd: 0.5 }), /must be at least \$1/);
  assert.deepEqual(await s.trader.setLimits({ maxOrderUsd: " " as unknown as number }), { auto: false, maxOrderUsd: undefined, maxDayUsd: undefined, maxOpenUsd: undefined });
});
