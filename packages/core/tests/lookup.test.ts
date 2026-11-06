import { test } from "node:test";
import assert from "node:assert/strict";
import { makeXSearchTool, splitTools, WEB_TOOLS, prefetchTools, charterText, CHARTERS, AGENTS, Jarvis, memoryStore, defineTool } from "../src/index.js";
import { z } from "zod";

test("x_search runs X through Grok for Claude agents: the CLI's JSON comes back as posts; a failure says so instead of guessing", async () => {
  const was = process.env.JARVIS_MOCK; delete process.env.JARVIS_MOCK;
  try {
    let prompt = "";
    const ok = makeXSearchTool(async (p) => { prompt = p; return JSON.stringify({ text: "@trader1 · Nov 6 · \"SOL bid\" · 900 likes · https://x.com/trader1/status/1\nAgree: it bounced.", stopReason: "end" }); });
    const out = await ok.handler({ query: "SOL", max: 5 }, { store: undefined as never, agentId: "mantis" });
    assert.match(prompt, /Search X \(Twitter\) for: SOL/);
    assert.match(prompt, /the 5 most relevant posts from the last 7 days/);
    assert.match(out, /^@trader1 · Nov 6/);
    // A repeat of the same query within 15 minutes is served from the cache; two at once share one Grok run.
    let calls = 0; let t = 1_000_000;
    const slow = makeXSearchTool(async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return JSON.stringify({ text: "@a · post" }); }, () => t);
    const ctx = { store: undefined as never, agentId: "mantis" };
    const [r1, r2] = await Promise.all([slow.handler({ query: "SOL" }, ctx), slow.handler({ query: "sol " }, ctx)]);
    assert.equal(calls, 1, "the same query in flight is shared");
    assert.equal(r1, "@a · post"); assert.equal(r2, "@a · post");
    t += 5 * 60_000;
    assert.match(await slow.handler({ query: "SOL" }, ctx), /@a · post\n\n\(X search from 5 min ago\.\)/);
    assert.equal(calls, 1, "served from the cache");
    t += 20 * 60_000;
    await slow.handler({ query: "SOL" }, ctx);
    assert.equal(calls, 2, "stale after 15 minutes");
    const down = makeXSearchTool(async () => { throw new Error("grok exited 1: not logged in"); });
    assert.match(await down.handler({ query: "SOL" }, { store: undefined as never, agentId: "mantis" }), /X search isn't available right now \(grok exited 1: not logged in\)/);
  } finally { if (was !== undefined) process.env.JARVIS_MOCK = was; }
});

test("web_search and web_fetch become Claude's own tools; Grok agents keep their native search and aren't told they're missing", async () => {
  const hq = defineTool({ name: "hyperliquid_perps", description: "", schema: { coins: z.array(z.string()).optional() }, async handler() { return "BTC 76,000"; } });
  const { hq: mcp, builtins } = splitTools([hq, ...WEB_TOOLS, makeXSearchTool()]);
  assert.deepEqual(mcp.map((t) => t.name), ["hyperliquid_perps", "x_search"]);
  assert.deepEqual(builtins, ["WebSearch", "WebFetch"]);
  const store = memoryStore(); await store.init();
  const block = await prefetchTools([hq, ...WEB_TOOLS, makeXSearchTool()], { store, agentId: "pentoshi" });
  assert.match(block, /### hyperliquid_perps\nBTC 76,000/);
  assert.doesNotMatch(block, /x_search|web_search|web_fetch/, "native-to-Grok tools are neither run nor listed as missing");
});

test("every agent has a source ladder in its charter, and every tool a charter names exists", async () => {
  const store = memoryStore(); await store.init();
  const names = new Set(new Jarvis({ store }).allTools().map((t) => t.name));
  const withSources = AGENTS.filter((a) => CHARTERS[a.id]?.sources?.length).length;
  assert.ok(withSources >= 45, `${withSources} agents have sources`);
  // Connector tools (Google, Spotify, Kubera, X, trading) only exist once that connector is set up.
  const connector = /^(google_|gmail_|calendar_|spotify_|kubera_|x_own_|x_mentions|x_dm_|trading_)/;
  for (const [id, c] of Object.entries(CHARTERS)) for (const t of c.tools ?? []) assert.ok(names.has(t) || connector.test(t), `${id} names unknown tool ${t}`);
  assert.match(charterText("mantis", (id) => id), /Where to look, in order:\n1\. hyperliquid_perps/);
  assert.ok(CHARTERS.mantis!.tools!.includes("x_search"), "Mantis (Claude) reaches X through x_search");
  assert.ok(!CHARTERS.pentoshi!.tools!.includes("x_search"), "Pentoshi (Grok) searches X natively");
});
