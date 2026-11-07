import { test } from "node:test";
import assert from "node:assert/strict";
import { xaiXSearch, xaiPrompt, makeXSearchTool, memoryStore, NO_X_SEARCH } from "../src/index.js";

const reply = (text: string, usage: Record<string, unknown> = {}) => new Response(JSON.stringify({
  model: "grok-4.7",
  output: [
    { type: "custom_tool_call", name: "x_keyword_search" },
    { type: "message", content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url: "https://x.com/houseofsweeps/status/1" }] }] },
  ],
  usage: { input_tokens: 2000, output_tokens: 400, server_side_tool_usage_details: { x_search_calls: 2, x_posts_fetched: 25, x_users_fetched: 1, ...usage } },
}), { status: 200, headers: { "content-type": "application/json" } });

test("xAI X search: the request filters by account and date, the posts come back as text, and each search is costed", async () => {
  process.env.XAI_API_KEY = "test-key";
  try {
    let body: Record<string, unknown> = {}, url = "", auth = "";
    const f = (async (u: string, init: RequestInit) => { url = u; auth = String((init.headers as Record<string, string>).authorization); body = JSON.parse(String(init.body)); return reply('@houseofsweeps · Nov 6 · "VKTX readout Nov 12" · 120 likes · https://x.com/houseofsweeps/status/1\nAgree: cautious. Disagree: timing.'); }) as unknown as typeof fetch;
    const r = await xaiXSearch({ query: "", handles: ["@houseofsweeps"], max: 25, days: 30 }, f, () => new Date("2026-11-07T05:00:00Z"));
    assert.equal(url, "https://api.x.ai/v1/responses");
    assert.equal(auth, "Bearer test-key");
    assert.equal(body.model, "grok-4.7");
    assert.deepEqual(body.tools, [{ type: "x_search", from_date: "2026-10-08", allowed_x_handles: ["houseofsweeps"] }]);
    assert.match(String((body.input as { content: string }[])[0]!.content), /25 most recent, most relevant posts by @houseofsweeps/);
    assert.match(r.text, /VKTX readout Nov 12/);
    assert.equal(r.posts, 25); assert.equal(r.calls, 2);
    assert.deepEqual(r.sources, ["https://x.com/houseofsweeps/status/1"]);
    // 25 posts at $5/1k + 1 profile at $10/1k + tokens.
    assert.ok(Math.abs(r.costUsd - (0.125 + 0.01 + 2000 * 1.25e-6 + 400 * 2.5e-6)) < 1e-9, String(r.costUsd));
    // A topic search has no handle filter.
    await xaiXSearch({ query: "SOL ETF", days: 7 }, f, () => new Date("2026-11-07T05:00:00Z"));
    assert.deepEqual(body.tools, [{ type: "x_search", from_date: "2026-10-31" }]);
    assert.match(xaiPrompt({ query: "SOL ETF", max: 10 }), /10 most recent, most relevant posts about: SOL ETF/);
    // The API refusing is an error with its status, not a made-up result.
    await assert.rejects(xaiXSearch({ query: "x" }, (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch), /xAI 401: bad key/);
  } finally { delete process.env.XAI_API_KEY; }
});

test("x_search prefers xAI when the key is set (from:handle becomes an account filter, the cost is logged); without it the Grok CLI's 'unavailable' is reported as such", async () => {
  const was = process.env.JARVIS_MOCK; delete process.env.JARVIS_MOCK;
  const store = memoryStore(); await store.init();
  try {
    process.env.XAI_API_KEY = "test-key";
    let seen: { query: string; handles?: string[]; max?: number } | undefined;
    const tool = makeXSearchTool(async () => { throw new Error("grok must not run when xAI is on"); }, Date.now, async (s) => { seen = s; return { text: "@houseofsweeps · Nov 6 · \"VKTX\" · 1 likes · https://x.com/houseofsweeps/status/1", posts: 25, calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.13, model: "grok-4.7", sources: [] }; });
    const out = await tool.handler({ query: "from:houseofsweeps", max: 25, days: 30 }, { store, agentId: "jarvis" });
    assert.match(out, /^@houseofsweeps · Nov 6/);
    assert.deepEqual(seen, { query: "", max: 25, days: 30, handles: ["houseofsweeps"] });
    const usage = await store.usage.since(new Date(Date.now() - 60_000));
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.provider, "xai:x_search"); assert.equal(usage[0]!.agentId, "jarvis"); assert.equal(usage[0]!.costUsd, 0.13);
    delete process.env.XAI_API_KEY;
    const cli = makeXSearchTool(async () => JSON.stringify({ text: "X search is unavailable.", stopReason: "end_turn" }));
    const r = await cli.handler({ query: "from:houseofsweeps" }, { store, agentId: "lucas" });
    assert.match(r, /X search isn't available right now \(the Grok CLI has no X search; set XAI_API_KEY/);
    assert.ok(NO_X_SEARCH.length > 10);
  } finally { delete process.env.XAI_API_KEY; if (was !== undefined) process.env.JARVIS_MOCK = was; }
});
