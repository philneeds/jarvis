import { test } from "node:test";
import assert from "node:assert/strict";
import { sdkTokens } from "../src/router/claude.js";

test("a run's input tokens include the cached prompt re-read on every turn, across every model it used", () => {
  // Shaped like the SDK's result message: `usage` is the last main-loop turn, `modelUsage` the whole run.
  const t = sdkTokens({
    usage: { input_tokens: 106, output_tokens: 900 },
    modelUsage: {
      "claude-fable-5-1": { inputTokens: 1_200, outputTokens: 14_000, cacheReadInputTokens: 380_000, cacheCreationInputTokens: 22_000 },
      "claude-haiku-5-5": { inputTokens: 300, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  });
  assert.deepEqual(t, { input: 403_500, output: 14_050 });
});

test("without modelUsage the main-loop usage still counts, and nothing at all counts as zero", () => {
  assert.deepEqual(sdkTokens({ usage: { input_tokens: 10, output_tokens: 5 } }), { input: 10, output: 5 });
  assert.deepEqual(sdkTokens({ usage: { input_tokens: 10 }, modelUsage: {} }), { input: 10, output: 0 });
  assert.deepEqual(sdkTokens({}), { input: 0, output: 0 });
});
