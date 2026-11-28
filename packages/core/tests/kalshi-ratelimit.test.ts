import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { memoryStore, KalshiTrader } from "../src/index.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/**
 * A stand-in Kalshi that keeps its documented rule for a standard account: the balance may be read once per window
 * (a second on the real thing; `windowMs` here), with no burst, and a read that comes sooner is refused with 429, the
 * documented body and X-RateLimit-Reset, and no Retry-After.
 */
function kalshi(windowMs: number) {
  let last = 0;
  const seen = { balance: 0, refused: 0 };
  const f = (async (url: string | URL | Request) => {
    const p = new URL(String(url)).pathname.replace("/trade-api/v2", "");
    if (p === "/portfolio/balance") {
      const now = Date.now();
      if (now - last < windowMs) { seen.refused++; return Response.json({ error: { code: "too_many_requests", message: "too many requests" } }, { status: 429, headers: { "x-ratelimit-reset": String((windowMs - (now - last)) / 1000) } }); }
      last = now; seen.balance++;
      return Response.json({ balance_dollars: "6541.82", portfolio_value: 600 });
    }
    if (p === "/portfolio/positions") return Response.json({ market_positions: [{ ticker: "KXNBAGAME-26NOV27MIANYK-NYK", position_fp: "600.00", market_exposure_dollars: "150.0000" }], cursor: "" });
    return Response.json({ orders: [], cursor: "" });
  }) as typeof fetch;
  return { f, seen };
}

test("Kalshi allows one balance read a second: Cat's two tools, one after the other or at once, never spend a second one", async () => {
  const store = memoryStore(); await store.init();
  // A window far longer than the test: any second balance read would be refused.
  const k = kalshi(60_000);
  const trader = new KalshiTrader(store, { keyId: "key-1", key: privateKey, fetch: k.f, gapMs: 0 });
  const tool = (name: string) => trader.tools().find((t) => t.name === name)!.handler({}, { store, agentId: "cat" });
  // One after the other, as Phil saw it fail on Nov 28 ("kalshi_trading succeeded; kalshi_account: rate limit").
  const trading = await tool("kalshi_trading");
  const account = await tool("kalshi_account");
  assert.match(trading, /^Kalshi trading is on: \$6,541\.82 cash/);
  assert.match(account, /^Kalshi: \$6,541\.82 cash, positions worth \$6\.\nPositions \(1\):\n- KXNBAGAME-26NOV27MIANYK-NYK: 600 YES, cost \$150/);
  // And again at once, with the holdings note's total and the Settings check on top.
  const again = await Promise.all([tool("kalshi_account"), tool("kalshi_trading"), trader.total(), trader.status(true)]);
  assert.match(again[0] as string, /^Kalshi: \$6,541\.82 cash/);
  assert.equal(k.seen.balance, 1, "one balance read served all six");
  assert.equal(k.seen.refused, 0, "and Kalshi never had to refuse one");
});

test("a balance read that is refused waits for the time Kalshi names and asks again; nobody upstream sees the refusal", async () => {
  const store = memoryStore(); await store.init();
  const k = kalshi(120);
  const trader = new KalshiTrader(store, { keyId: "key-1", key: privateKey, fetch: k.f, gapMs: 0 });
  // Something else on the account read the balance a moment ago (another HQ process, Phil's own script).
  await k.f("https://external-api.kalshi.com/trade-api/v2/portfolio/balance");
  const t0 = Date.now();
  const s = await trader.status(true);
  assert.equal(s.trading, true);
  assert.equal(s.balance, 6541.82);
  assert.equal(k.seen.refused, 1);
  assert.ok(Date.now() - t0 >= 100, "it waited for the bucket rather than asking again at once");
  assert.equal(k.seen.balance, 2);
});
