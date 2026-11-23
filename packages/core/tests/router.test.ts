import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRouter, memoryStore, getAgent, MODELS, ProviderError, isUsageLimit, type Provider } from "../src/index.js";

const LIMIT = "Claude Agent SDK failed: Claude Code returned an error result: You've hit your 5-hour limit · resets 4:40pm (America/New_York)";

/** A Claude provider that fails on the models named in `failing` and answers on anything else. */
function fakeClaude(failing: Record<string, string>) {
  const seen: string[] = [];
  const p: Provider = {
    id: "claude:agent-sdk",
    async available() { return { ok: true }; },
    async run(req) {
      seen.push(req.model.key);
      const why = failing[req.model.key];
      if (why) throw new ProviderError(why, "claude:agent-sdk");
      return { text: `hello from ${req.model.key}`, provider: "claude:agent-sdk", modelId: req.model.modelId ?? req.model.key, inputTokens: 10, outputTokens: 5, costUsd: 0, durationMs: 1 };
    },
  };
  return { p, seen };
}

const noKey: Provider = { id: "claude:api", async available() { return { ok: false, reason: "ANTHROPIC_API_KEY not set" }; }, async run() { throw new Error("never"); } };

test("usage-limit errors are recognised; real errors are not", () => {
  assert.ok(isUsageLimit(LIMIT));
  assert.ok(isUsageLimit("Claude API failed: 429 rate_limit_error"));
  assert.ok(isUsageLimit("You've reached your weekly limit"));
  assert.ok(!isUsageLimit("Claude Agent SDK failed: ENOENT claude binary"));
  assert.ok(!isUsageLimit("tool failed: maximum number of turns reached"));
});

test("Fable's limit falls back to Opus on the same provider; the run is recorded on Opus", async () => {
  const store = memoryStore(); await store.init();
  const { p, seen } = fakeClaude({ "claude-fable": LIMIT });
  const router = new ModelRouter({ store, providers: { claude: [p, noKey], grok: [] } });
  const einstein = getAgent("einstein")!;
  assert.equal(einstein.model, "claude-fable");
  const out = await router.run(einstein, { system: "s", prompt: "Einstein asks: fix it", direct: true });
  assert.equal(out.blocked, undefined);
  assert.deepEqual(seen, ["claude-fable", "claude-opus"]);
  assert.equal(out.modelId, MODELS["claude-opus"].modelId);
  assert.equal(out.text, "hello from claude-opus");
  const run = (await store.runs.get(out.runId))!;
  assert.equal(run.status, "done");
  assert.equal(run.modelId, MODELS["claude-opus"].modelId);
  const log = await store.activity.list({ agentId: "einstein" });
  assert.ok(log.some((e) => e.kind === "system" && /hit the Claude Fable usage limit; retrying on Claude Opus/.test(e.summary)));
});

test("a real error on Fable does not retry on Opus", async () => {
  const store = memoryStore(); await store.init();
  const { p, seen } = fakeClaude({ "claude-fable": "Claude Agent SDK failed: something broke" });
  const router = new ModelRouter({ store, providers: { claude: [p, noKey], grok: [] } });
  const out = await router.run(getAgent("einstein")!, { system: "s", prompt: "x", direct: true });
  assert.deepEqual(seen, ["claude-fable"]);
  assert.match(out.blocked!, /something broke \| claude:api: ANTHROPIC_API_KEY not set/);
});

test("a plan-wide limit stops Opus too; the error names both tries and the missing API key", async () => {
  const store = memoryStore(); await store.init();
  const { p, seen } = fakeClaude({ "claude-fable": LIMIT, "claude-opus": LIMIT });
  const router = new ModelRouter({ store, providers: { claude: [p, noKey], grok: [] } });
  const out = await router.run(getAgent("einstein")!, { system: "s", prompt: "x", direct: true });
  assert.deepEqual(seen, ["claude-fable", "claude-opus"]);
  assert.match(out.blocked!, /claude:agent-sdk: .*5-hour limit.* \| claude:agent-sdk on Claude Opus: .*5-hour limit.* \| claude:api: ANTHROPIC_API_KEY not set/);
  // Opus itself has no fallback: Jarvis on Opus hitting the limit goes straight down the chain.
  const { p: p2, seen: seen2 } = fakeClaude({ "claude-opus": LIMIT });
  const r2 = new ModelRouter({ store, providers: { claude: [p2, noKey], grok: [] } });
  const jarvis = getAgent("jarvis")!;
  await r2.run(jarvis, { system: "s", prompt: "x", direct: true });
  assert.deepEqual(seen2, [jarvis.model]);
});

/** A Grok CLI that answers everything, and remembers what it was asked. */
function fakeGrok() {
  const seen: string[] = [];
  const p: Provider = {
    id: "grok:cli",
    async available() { return { ok: true }; },
    async run(req) {
      seen.push(req.model.key);
      return { text: `grok says: ${req.prompt}`, provider: "grok:cli", modelId: "grok-4.7", inputTokens: 8, outputTokens: 4, costUsd: 0, durationMs: 1 };
    },
  };
  return { p, seen };
}

test("Claude's plan at its limit: a run with no tools goes out on Grok, recorded on the SuperGrok plan", async () => {
  const store = memoryStore(); await store.init();
  const { p, seen } = fakeClaude({ "claude-opus": LIMIT });
  const { p: grok, seen: grokSeen } = fakeGrok();
  const router = new ModelRouter({ store, providers: { claude: [p, noKey], grok: [grok] } });
  const jarvis = getAgent("jarvis")!;
  const out = await router.run(jarvis, { system: "s", prompt: "The card went through", direct: true });
  assert.equal(out.blocked, undefined);
  assert.deepEqual(seen, ["claude-opus"]);
  assert.deepEqual(grokSeen, ["grok"]);
  assert.equal(out.provider, "grok:cli");
  assert.equal(out.text, "grok says: The card went through");
  const run = (await store.runs.get(out.runId))!;
  assert.equal(run.status, "done");
  assert.equal(run.provider, "grok:cli");
  const usage = await store.usage.since(new Date(Date.now() - 60_000));
  assert.deepEqual(usage.map((u) => u.plan), ["supergrok"]);
  const log = await store.activity.list({ agentId: "jarvis" });
  assert.ok(log.some((e) => e.kind === "system" && /Claude's plan is at its limit; Jarvis's answer goes out on Grok/.test(e.summary)));
  assert.ok(!log.some((e) => e.kind === "error"));
});

test("Claude's plan at its limit: a run with tools, or a real error, does not go to Grok", async () => {
  const store = memoryStore(); await store.init();
  const { p } = fakeClaude({ "claude-opus": LIMIT });
  const { p: grok, seen: grokSeen } = fakeGrok();
  const router = new ModelRouter({ store, providers: { claude: [p, noKey], grok: [grok] } });
  const tool = { name: "web_status", description: "", schema: {}, handler: async () => "" };
  const withTools = await router.run(getAgent("jarvis")!, { system: "s", prompt: "x", direct: true, tools: [tool] });
  assert.match(withTools.blocked!, /5-hour limit/);
  // Fable's own cap, then a real failure on Opus: that is a bug to surface, not a plan limit to route around.
  const { p: p2 } = fakeClaude({ "claude-fable": LIMIT, "claude-opus": "Claude Agent SDK failed: something broke" });
  const r2 = new ModelRouter({ store, providers: { claude: [p2, noKey], grok: [grok] } });
  const broke = await r2.run(getAgent("einstein")!, { system: "s", prompt: "x", direct: true });
  assert.match(broke.blocked!, /something broke/);
  assert.deepEqual(grokSeen, []);
});
