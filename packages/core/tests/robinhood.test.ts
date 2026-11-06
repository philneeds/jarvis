import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memoryStore, RobinhoodConnector, sseResult, Jarvis, CHARTERS } from "../src/index.js";

test("Robinhood: HQ registers itself, signs Phil in with PKCE, speaks MCP over HTTP, reads freely and writes only on approval", async () => {
  const store = memoryStore(); await store.init();
  let now = Date.parse("2026-11-06T21:00:00Z");
  const seen: { url: string; body?: string; headers: Record<string, string> }[] = [];
  let challenge = "", tokenCalls = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const h = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: u.pathname, body: init?.body ? String(init.body) : undefined, headers: h });
    if (u.pathname === "/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: "https://robinhood.com/oauth", token_endpoint: "https://api.robinhood.com/oauth2/token/", registration_endpoint: "https://agent.robinhood.com/oauth/trading/register", scopes_supported: ["internal"], code_challenge_methods_supported: ["S256"] });
    if (u.pathname === "/oauth/trading/register") return Response.json({ client_id: "cid-1", redirect_uris: ["https://hq.test/api/connectors/robinhood/callback"] });
    if (u.pathname === "/oauth2/token/") {
      tokenCalls++;
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "authorization_code") { assert.equal(form.get("client_id"), "cid-1"); assert.equal(form.get("code"), "the-code"); assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge, "PKCE verifier matches the challenge"); return Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }); }
      if (form.get("grant_type") === "refresh_token") { assert.equal(form.get("refresh_token"), "rt-1"); return Response.json({ access_token: "at-2", expires_in: 3600 }); }
      return new Response("bad", { status: 400 });
    }
    if (u.pathname === "/mcp/trading") {
      if (!/^Bearer at-[12]$/.test(h.authorization)) return new Response("authentication required", { status: 401 });
      const rpc = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (rpc.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "robinhood" } } }), { headers: { "content-type": "application/json", "mcp-session-id": "sess-9" } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      assert.equal(h["mcp-session-id"], "sess-9", "the session id goes on every later call");
      if (rpc.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "get_positions", description: "Positions across accounts", annotations: { readOnlyHint: true } }, { name: "place_order", description: "Place an order in the agentic account", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } }, { name: "get_quote", description: "Quote for a symbol" }] } });
      if (rpc.method === "tools/call") {
        if (rpc.params?.name === "get_positions") return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "AAPL 10 sh · NVDA 5 sh" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        if (rpc.params?.name === "place_order") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `order placed: ${JSON.stringify(rpc.params.arguments)}` }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "no such method" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const rh = new RobinhoodConnector(store, { mcpUrl: "https://agent.robinhood.com/mcp/trading", redirectUri: "https://hq.test/api/connectors/robinhood/callback", fetch: f, now: () => now });
  const { url, state } = await rh.authUrl();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://robinhood.com/oauth");
  assert.equal(u.searchParams.get("client_id"), "cid-1");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  challenge = u.searchParams.get("code_challenge")!;
  assert.match(seen.find((s) => s.url === "/oauth/trading/register")!.body!, /"token_endpoint_auth_method":"none"/);
  await assert.rejects(rh.exchangeCode("x", "wrong-state"), /unknown sign-in state/);
  await rh.exchangeCode("the-code", state);
  assert.equal((await rh.status()).connected, true);

  const jarvis = new Jarvis({ store });
  jarvis.addConnector(rh, RobinhoodConnector.promptHint());
  const t = (n: string) => rh.tools().find((x) => x.name === n)!;
  const ctx = { store, agentId: "buffett" };
  const list = await t("robinhood_tools").handler({}, ctx);
  assert.match(list, /read get_positions: Positions across accounts/);
  assert.match(list, /WRITE \(approval\) place_order/);
  assert.match(list, /read get_quote/, "no annotation and no write-looking name counts as a read");
  assert.equal(await t("robinhood_read").handler({ tool: "get_positions" }, ctx), "AAPL 10 sh · NVDA 5 sh", "an SSE answer is read");
  assert.match(await t("robinhood_read").handler({ tool: "place_order", args: { symbol: "AAPL" } }, ctx), /changes something, so it isn't a read/);
  assert.match(await t("robinhood_read").handler({ tool: "nope" }, ctx), /no tool called nope/);

  // An order: waits as a money approval, runs on approval.
  const a = await jarvis.requestApproval({ agentId: "buffett", kind: "money", title: "Buy 1 AAPL", body: "why", payload: { action: "robinhood.call", tool: "place_order", args: { symbol: "AAPL", qty: 1 } } });
  assert.equal(a.status, "pending");
  assert.match(a.effect ?? "", /placed in your Robinhood Agentic account the moment you approve/);
  const calls = seen.filter((s) => s.body?.includes('"place_order"') && s.body.includes("tools/call")).length;
  assert.equal(calls, 0, "nothing placed before approval");
  const done = await jarvis.decide(a.id, "approved", "ok");
  assert.match(done?.note ?? "", /Robinhood place_order: order placed: \{"symbol":"AAPL","qty":1\}/);

  // An expired token refreshes on its own.
  now += 3600_000;
  assert.equal(await t("robinhood_read").handler({ tool: "get_positions" }, ctx), "AAPL 10 sh · NVDA 5 sh");
  assert.equal(tokenCalls, 2, "one exchange, one refresh");
  assert.ok(CHARTERS.buffett!.tools!.includes("robinhood_read") && CHARTERS.munger!.tools!.includes("robinhood_read"));
  assert.equal(sseResult("data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":1}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":8,\"result\":2}\n\n", 8)!.result, 2);
});
