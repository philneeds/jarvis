import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { memoryStore, holdingsNote, venueSection, kuberaFigure, hlAccountTotal, KalshiTrader, type LiveVenue } from "../src/index.js";

const kuberaDay = (items: Record<string, number>) => [{ day: "2026-11-27", netWorth: 71_999, assets: 0, debts: 0, items }];

test("a venue read straight from the source is the truth for it, and the gap to Kubera's figure is said in dollars", async () => {
  const store = memoryStore(); await store.init();
  // Kubera's own link to Kalshi counts the cash it last saw; the account holds ten times that (Phil, Nov 27 2026).
  await store.settings.set("kubera.history", kuberaDay({ "Kalshi - Cash": 611.02, "Robinhood 1888": 96_728 }));
  assert.equal(await kuberaFigure(store, /kalshi/i), 611.02);
  assert.equal(await kuberaFigure(store, /hyperliquid/i), undefined);
  const kalshi: LiveVenue = { name: "Kalshi", match: /kalshi/i, text: async () => "Kalshi: $3,189 cash, positions worth $2,841.", total: async () => 6030.5 };
  const k = (await venueSection(store, kalshi))!;
  assert.match(k, /^Kalshi, read straight from Kalshi just now \(for this account these figures are the real ones\):\nKalshi: \$3,189 cash, positions worth \$2,841\.\n/);
  assert.match(k, /Kubera has Kalshi at \$611; the account itself holds \$6,031\. So Kubera's net worth figure is about \$5,419 too low on this account alone/);
  // An account Kubera doesn't list at all: said as left out, with the caveat that he may track it under another name.
  const hl: LiveVenue = { name: "Hyperliquid", match: /hyperliquid/i, text: async () => "Main: perps account value $402.", total: async () => 402.51 };
  assert.match((await venueSection(store, hl))!, /Kubera has no line named for Hyperliquid: unless Phil tracks it there under another name, its net worth figure leaves out this \$403\./);
  // Close enough is timing, not a gap; and a figure that ran ahead of the account is "too high".
  await store.settings.set("kubera.history", kuberaDay({ Kalshi: 6_000 }));
  assert.doesNotMatch((await venueSection(store, kalshi))!, /Kubera has/);
  await store.settings.set("kubera.history", kuberaDay({ Kalshi: 9_000 }));
  assert.match((await venueSection(store, kalshi))!, /about \$2,970 too high/);
});

test("the note holds every source that answered; one that fails says so and the rest still come through", async () => {
  const store = memoryStore(); await store.init();
  const note = await holdingsNote(store, {
    kubera: async () => "Kubera: net worth $71,999.",
    robinhood: async () => { throw new Error("Robinhood isn't connected"); },
    venues: [
      { name: "Kalshi", match: /kalshi/i, text: async () => { throw new Error("Kalshi's rate limit is hit; try again in a moment"); } },
      { name: "Hyperliquid", match: /hyperliquid/i, text: async () => undefined },
      { name: "Lighter", match: /lighter/i, text: async () => "Main: $10.", total: async () => { throw new Error("no total"); } },
    ],
  });
  assert.deepEqual(note.split("\n\n"), [
    "Kubera: net worth $71,999.",
    "Robinhood couldn't be read: Robinhood isn't connected",
    "Kalshi couldn't be read just now: Kalshi's rate limit is hit; try again in a moment",
    "Lighter, read straight from Lighter just now (for this account these figures are the real ones):\nMain: $10.",
  ]);
  assert.equal(await holdingsNote(store, {}), "");
});

test("Hyperliquid's total is the perps account plus dollars in Spot, read for the account an API wallet trades for", async () => {
  const asked: string[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { type: string; user: string };
    asked.push(`${b.type}:${b.user.slice(0, 6)}`);
    if (b.type === "userRole") return Response.json({ role: "agent", data: { user: "0x" + "b".repeat(40) } });
    if (b.type === "clearinghouseState") return Response.json({ marginSummary: { accountValue: "150.25" } });
    return Response.json({ balances: [{ coin: "USDC", total: "402.51" }, { coin: "HYPE", total: "3" }] });
  }) as typeof fetch;
  assert.equal(await hlAccountTotal({ label: "Main", address: "0x" + "a".repeat(40) }, f), 552.76);
  assert.deepEqual(asked.slice(1).sort(), ["clearinghouseState:0xbbbb", "spotClearinghouseState:0xbbbb"], "the owner's account, not the API wallet's");
});

test("Kalshi: two tools asking in the same moment share one balance read, and the account total is cash plus positions", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const store = memoryStore(); await store.init();
  let balance = 0;
  const f = (async (url: string | URL | Request) => {
    const p = new URL(String(url)).pathname.replace("/trade-api/v2", "");
    if (p === "/portfolio/balance") { balance++; await new Promise((r) => setTimeout(r, 5)); return Response.json({ balance_dollars: "3189.30", portfolio_value: 284_120 }); }
    if (p === "/portfolio/positions") return Response.json({ market_positions: [], cursor: "" });
    return Response.json({ orders: [], cursor: "" });
  }) as typeof fetch;
  const k = new KalshiTrader(store, { keyId: "key-1", key: privateKey, fetch: f, retryMs: 1, gapMs: 0 });
  const tool = (name: string) => k.tools().find((t) => t.name === name)!.handler({}, { store, agentId: "cat" });
  const [trading, account, total] = await Promise.all([tool("kalshi_trading"), tool("kalshi_account"), k.total()]);
  assert.equal(balance, 1, "one request for all three");
  assert.match(trading, /^Kalshi trading is on: \$3,189\.30 cash, positions worth \$2,841\.20\./);
  assert.match(account, /^Kalshi: \$3,189\.30 cash, positions worth \$2,841\.20\./);
  assert.equal(Math.round(total!), 6031);
});
