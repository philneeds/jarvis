import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, Jarvis, ModelRouter, mockProvider, CHARTERS } from "../src/index.js";

test("goals Phil states go in as one card with their benchmarks, no relay through Adam (Nov 20)", async () => {
  const store = memoryStore(); await store.init();
  const provider = mockProvider("m");
  const ran: string[] = [];
  provider.run = async (req) => { ran.push(req.agent.id); return { text: "ok", provider: "m", modelId: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }; };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  const card = await jarvis.requestApproval({ agentId: "david", kind: "record", title: "Set your goals", body: "In Phil's words", payload: { action: "goals.set", add: [
    { name: "$6k/month steady", horizon: "mid", primary: true, benchmarks: [{ text: "Last 3 months' income written down", weight: 20 }, { text: "1 month at $6k+", weight: 30 }, { text: "3 straight months at $6k+", weight: 50 }] },
    { name: "$10k/month steady", horizon: "long", benchmarks: [{ text: "1 month at $10k+", weight: 40 }, { text: "3 straight months at $10k+", weight: 60 }] },
    { name: "Same income passively", horizon: "long" },
  ] } });
  assert.equal(card.status, "pending", "Phil approves his goals once");
  assert.match(card.effect ?? "", /\$6k\/month steady \(primary\), with 3 benchmarks; \$10k\/month steady, with 2 benchmarks; Same income passively/);
  const done = await jarvis.decide(card.id, "approved");
  assert.match(done?.note ?? "", /Goals set: \$6k\/month steady; \$10k\/month steady; Same income passively \(with benchmarks: \$6k\/month steady; \$10k\/month steady\)/);
  const goals = await jarvis.goals();
  const six = goals.find((g) => g.name === "$6k/month steady")!;
  assert.deepEqual(six.benchmarks?.map((b) => b.text), ["Last 3 months' income written down", "1 month at $6k+", "3 straight months at $6k+"]);
  assert.equal(six.primary, true);
  // David is woken only for the goal that came without benchmarks.
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual(ran, ["david"]);
  assert.match(CHARTERS.david!.owns.join(" "), /Goals Phil states himself.*never a hand-off to Adam first/);
});
