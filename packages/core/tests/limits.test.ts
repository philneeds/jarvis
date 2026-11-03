import { test } from "node:test";
import assert from "node:assert/strict";
import { TradingGuard, memoryStore, Jarvis, ModelRouter, mockProvider, getAgent } from "../src/index.js";

function make() {
  const store = memoryStore();
  const guard = new TradingGuard(store);
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("g")] } }) });
  jarvis.addConnector(guard, TradingGuard.promptHint());
  jarvis.onApprovalRequested(async (a) => {
    if ((a.payload as { action?: string } | undefined)?.action !== "trade.execute") return undefined;
    const { parseTrade } = await import("../src/index.js");
    const c = await guard.check(parseTrade(a.payload));
    return c.ok ? undefined : `Mayne's hard limits: ${c.reason}`;
  });
  return { store, guard, jarvis };
}

test("over-size trades are refused before Phil sees them", async () => {
  const { jarvis, store } = make();
  const a = await jarvis.requestApproval({ agentId: "mayne", kind: "money", title: "Long SOL $900", body: "", payload: { action: "trade.execute", symbol: "SOL", side: "long", sizeUsd: 900 } });
  assert.equal(a.status, "rejected");
  assert.match(a.note!, /over the max position of \$250/);
  assert.equal((await store.approvals.list("pending")).length, 0);
});

test("limits apply at execution even after approval; daily loss trips the kill switch", async () => {
  const { jarvis, store, guard } = make();
  const ok = await jarvis.requestApproval({ agentId: "mayne", kind: "money", title: "Long SOL $200", body: "", payload: { action: "trade.execute", symbol: "SOL", side: "long", sizeUsd: 200 } });
  assert.equal(ok.status, "pending");
  await guard.setLimits({ maxPositionUsd: 100 }); // Phil tightens the limit while it waits
  await jarvis.decide(ok.id, "approved");
  const log = await store.activity.list({ agentId: "mayne" });
  assert.ok(log.some((e) => /blocked by Mayne's hard limits/.test(e.summary)));
  assert.equal((await guard.ledger()).open.length, 0);

  await guard.setLimits({ maxPositionUsd: 250, maxDailyLossUsd: 300 });
  const t = await jarvis.requestApproval({ agentId: "mayne", kind: "money", title: "Long SOL $200", body: "", payload: { action: "trade.execute", symbol: "SOL", side: "long", sizeUsd: 200 } });
  await jarvis.decide(t.id, "approved");
  const led = await guard.ledger();
  assert.equal(led.open.length, 1);
  const r = await guard.close(led.open[0]!.id, -350);
  assert.match(r.stopped!, /daily loss/);
  const kill = await store.settings.get("killSwitch", { trading: false });
  assert.equal(kill.trading, true);
  const again = await guard.check({ symbol: "SOL", sizeUsd: 50, side: "long" });
  assert.equal(again.ok, false);
  const blocked = await jarvis.runAgent(getAgent("mayne")!, "buy", { direct: true });
  assert.match(blocked.blocked!, /trading is paused/);
});

test("drawdown auto-stop and the limits tool", async () => {
  const { guard } = make();
  await guard.markEquity(10_000);
  assert.equal((await guard.markEquity(9_500)).stopped, undefined);
  assert.match((await guard.markEquity(8_900)).stopped!, /drawdown 11\.0%/);
  const tool = guard.tools()[0]!;
  assert.match(await tool.handler({}, { store: guard["store" as keyof TradingGuard] as never, agentId: "mayne" }), /AUTO-STOP ON/);
});
