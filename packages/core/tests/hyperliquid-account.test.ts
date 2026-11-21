import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, accountText, hlAccounts, HL_ACCOUNTS_KEY, HYPERLIQUID_TOOLS, CHARTERS, prefetchTools } from "../src/index.js";

const ME = "0x1111111111111111111111111111111111111111";
function fakeHl() {
  const asked: string[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { type: string; user: string };
    asked.push(b.type);
    if (b.type === "clearinghouseState") return Response.json({
      marginSummary: { accountValue: "10000", totalNtlPos: "30000", totalMarginUsed: "2500" }, withdrawable: "7500",
      assetPositions: [
        { position: { coin: "ETH", szi: "5", entryPx: "3000", positionValue: "16000", unrealizedPnl: "1000", returnOnEquity: "0.5", liquidationPx: "2900", leverage: { type: "cross", value: 10 }, cumFunding: { sinceOpen: "12.5" } } },
        { position: { coin: "BTC", szi: "-0.2", entryPx: "70000", positionValue: "14000", unrealizedPnl: "-200", returnOnEquity: "-0.1", liquidationPx: "90000", leverage: { type: "isolated", value: 5 }, cumFunding: { sinceOpen: "-3" } } },
        { position: { coin: "SOL", szi: "0", positionValue: "0" } },
      ],
    });
    if (b.type === "frontendOpenOrders") return Response.json([{ coin: "BTC", side: "B", limitPx: "65000", sz: "0.2", orderType: "Limit", reduceOnly: true }]);
    if (b.type === "userFills") return Response.json([{ coin: "ETH", px: "3100", sz: "1", side: "A", time: Date.parse("2026-11-19T15:00:00Z"), dir: "Close Long", closedPnl: "100", fee: "1.5" }, { coin: "ETH", px: "2000", sz: "1", side: "B", time: Date.parse("2026-11-10T15:00:00Z"), dir: "Open Long" }]);
    if (b.type === "spotClearinghouseState") return Response.json({ balances: [{ coin: "USDC", total: "250.5" }, { coin: "HYPE", total: "10", entryNtl: "300" }, { coin: "PURR", total: "0" }] });
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  return { f, asked };
}

test("Phil's Hyperliquid account in words: value, positions with liquidation distance, orders, the day's fills, spot", async () => {
  const { f, asked } = fakeHl();
  const t = await accountText({ label: "Main", address: ME }, f, Date.parse("2026-11-19T16:00:00Z"));
  assert.deepEqual(asked.sort(), ["clearinghouseState", "frontendOpenOrders", "spotClearinghouseState", "userFills", "userRole"], "only public reads");
  assert.match(t, /^Main \(0x1111…1111\): perps account value \$10,000, margin used \$2,500 \(25% of it\), withdrawable \$7,500, open positions \$30,000 \(3\.0x the account\)\./);
  // ETH: mark 3,200, liquidation 2,900 → 9.4% away: flagged and listed first.
  assert.match(t, /Positions \(2\):\n- ⚠ CLOSE TO LIQUIDATION · ETH long 5 @ 3,000 · mark 3,200 · \$16,000 · uPnL \+\$1,000 \(\+50\.0% on margin\) · 10x cross · liquidation 2,900 \(9\.4% away\) · funding since open paid \$13/);
  assert.match(t, /- BTC short 0\.2 @ 70,000 · mark 70,000 · \$14,000 · uPnL -\$200 \(-10\.0% on margin\) · 5x isolated · liquidation 90,000 \(28\.6% away\) · funding since open received \$3/);
  assert.doesNotMatch(t, /SOL/, "a closed position isn't listed");
  assert.match(t, /Open orders \(1\):\n- BTC buy 0\.2 @ 65,000 · Limit · reduce-only/);
  assert.match(t, /Fills in the last 24h \(1; closed PnL \+\$100, fees \$2\):\n- Nov 19, 10:00 AM ETH Close Long 1 @ 3,100 · closed \+\$100/);
  assert.match(t, /Spot: USDC 250\.5, HYPE 10 \(cost \$300\)\./);
});

test("accounts come from Settings (else HYPERLIQUID_ADDRESS); Pentoshi has the tool, and on Grok gets it run for him", async () => {
  const store = memoryStore(); await store.init();
  assert.deepEqual(await hlAccounts(store, {}), []);
  assert.deepEqual(await hlAccounts(store, { HYPERLIQUID_ADDRESS: `Main=${ME},bad=0x12` }), [{ label: "Main", address: ME }]);
  const tool = HYPERLIQUID_TOOLS.find((t) => t.name === "hyperliquid_account")!;
  assert.match(await tool.handler({}, { store, agentId: "pentoshi" }), /No Hyperliquid account set\. Phil adds his wallet's public address/);
  await store.settings.set(HL_ACCOUNTS_KEY, [{ label: "Main", address: ME }]);
  assert.match(await tool.handler({ account: "sub" }, { store, agentId: "pentoshi" }), /No Hyperliquid account called "sub"; Phil's are Main/);
  assert.ok(CHARTERS.pentoshi!.tools!.includes("hyperliquid_account"));
  // Pentoshi runs on Grok, which can't call HQ's tools: a tool with no required input is run for him up front.
  const { f } = fakeHl();
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const pre = await prefetchTools([tool], { store, agentId: "pentoshi" });
    assert.match(pre, /### hyperliquid_account\nMain \(0x1111…1111\): perps account value \$10,000/);
  } finally { globalThis.fetch = real; }
});

test("an empty list saved in Settings stays empty: removing the last account doesn't bring back the environment's", async () => {
  const { lighterAccounts, LIGHTER_ACCOUNTS_KEY, polyAccounts, POLY_ACCOUNTS_KEY } = await import("../src/index.js");
  const store = memoryStore(); await store.init();
  const env = { HYPERLIQUID_ADDRESS: ME, LIGHTER_ADDRESS: ME, POLYMARKET_ADDRESS: ME };
  assert.equal((await hlAccounts(store, env)).length, 1, "the environment is the first default");
  await store.settings.set(HL_ACCOUNTS_KEY, []); await store.settings.set(LIGHTER_ACCOUNTS_KEY, []); await store.settings.set(POLY_ACCOUNTS_KEY, []);
  assert.deepEqual(await hlAccounts(store, env), []);
  assert.deepEqual(await lighterAccounts(store, env), []);
  assert.deepEqual(await polyAccounts(store, env), []);
});

test("an API wallet's address in Settings reads the account it trades for; a trade address alone is the default account", async () => {
  const API = "0x941c000000000000000000000000000000007346", MAIN = "0xec36697c3c8c8e385b37e17df40dbcbe2dbd9ffc";
  const users: string[] = [];
  const f = (async (_u: string | URL | Request, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { type: string; user: string };
    if (b.type === "userRole") return Response.json(b.user === API ? { role: "agent", data: { user: MAIN } } : { role: "user" });
    users.push(b.user);
    if (b.type === "clearinghouseState") return Response.json({ marginSummary: { accountValue: "40", totalNtlPos: "0", totalMarginUsed: "0" }, withdrawable: "40", assetPositions: [] });
    return Response.json(b.type === "spotClearinghouseState" ? { balances: [] } : []);
  }) as typeof fetch;
  const t = await accountText({ label: "Main", address: API }, f);
  assert.ok(users.every((u) => u === MAIN), "every read is of the main account");
  assert.match(t, /^Main \(0xec36…9ffc; 0x941c…7346, the address in Settings, is the API wallet that trades for it\): perps account value \$40/);
  assert.deepEqual(await hlAccounts(memoryStore(), { HYPERLIQUID_TRADE_ADDRESS: MAIN }), [{ label: "Main", address: MAIN }]);
});
