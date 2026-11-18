import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { memoryStore, Jarvis, ModelRouter, mockProvider, getAgent, defineTool } from "../src/index.js";

test("an agent working LeadPerfection's screens gets 24 tool rounds, not the default 8", async () => {
  const store = memoryStore(); await store.init();
  const provider = mockProvider("m");
  const turns: (number | undefined)[] = [];
  provider.run = async (req) => { turns.push(req.maxTurns); return { text: "ok", provider: "m", modelId: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }; };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  jarvis.addConnector({ id: "leadperfection", tools: () => [defineTool({ name: "lp_open", description: "x", schema: { screen: z.string() }, handler: async () => "screen" })], executors: () => ({}) } as never, "LP");
  await jarvis.runAgent(getAgent("stevon")!, "Check Robak's schedule", { direct: true });
  assert.equal(turns.at(-1), 24);
  await jarvis.runAgent(getAgent("munger")!, "Net worth", { direct: true });
  assert.equal(turns.at(-1), undefined, "everyone else keeps the default");
});
