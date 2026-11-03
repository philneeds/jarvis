import { test } from "node:test";
import assert from "node:assert/strict";
import { XConnector, memoryStore, Jarvis, ModelRouter, mockProvider } from "../src/index.js";

function fakeX() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let users = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); calls.push({ url: u, init });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/oauth2/token")) { const b = String(init?.body); return json({ access_token: b.includes("refresh_token") ? "at2" : "at1", refresh_token: "rt", expires_in: 7200 }); }
    if (u.endsWith("/users/me")) { users++; return json({ data: { id: `u${users}`, username: users === 1 ? "philneeds" : "rangecool", name: "Phil" } }); }
    if (/\/users\/u\d\/mentions/.test(u)) return json({ data: [{ id: "900", text: "@philneeds when's the next drop?", author_id: "77", created_at: "2026-11-03T10:00:00Z" }] });
    if (/\/users\/u\d\/tweets/.test(u)) return json({ data: [{ id: "800", text: "gm", public_metrics: { like_count: 12 } }] });
    if (u.endsWith("/tweets")) return json({ data: { id: "901" } });
    if (/\/dm_conversations\/with\/77\/messages/.test(u)) return json({ data: { dm_event_id: "dm1" } });
    if (u.includes("/dm_events")) return json({ data: [{ id: "dm0", text: "hey", sender_id: "77" }] });
    return json({ error: u }, 500);
  }) as typeof fetch;
  return { f, calls };
}

test("PKCE auth, two accounts, reads and refresh", async () => {
  const store = memoryStore(); await store.init();
  const { f, calls } = fakeX();
  let now = 1_000_000;
  const x = new XConnector(store, { clientId: "cid", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: f, now: () => now });
  const a1 = x.authUrl();
  assert.match(a1.url, /code_challenge_method=S256/);
  assert.equal((await x.exchangeCode("c1", a1.state)).handle, "philneeds");
  await assert.rejects(x.exchangeCode("c1", "bogus"), /unknown OAuth state/);
  const a2 = x.authUrl();
  assert.equal((await x.exchangeCode("c2", a2.state)).handle, "rangecool");
  assert.deepEqual((await x.status()).accounts.map((a) => a.handle), ["philneeds", "rangecool"]);
  assert.equal((await x.mentions())[0]!.id, "900");
  assert.equal((await x.ownPosts("@rangecool"))[0]!.text, "gm");
  await assert.rejects(x.mentions("acres"), /isn't connected/);
  now += 3 * 3600 * 1000;
  await x.dmInbox();
  assert.ok(calls.some((c) => String(c.init?.body).includes("grant_type=refresh_token")));
});

test("posting waits for Phil; the executor posts from the named account", async () => {
  const store = memoryStore(); await store.init();
  const { f, calls } = fakeX();
  const x = new XConnector(store, { clientId: "cid", redirectUri: "http://hq/cb", fetch: f });
  const s = x.authUrl(); await x.exchangeCode("c", s.state);
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("g")] } }) });
  jarvis.addConnector(x, XConnector.promptHint());
  const a = await jarvis.requestApproval({ agentId: "boo", kind: "post", title: "gm post", body: "gm", payload: { action: "x.post", account: "philneeds", text: "gm. shipping all week." } });
  assert.equal(a.status, "pending");
  assert.ok(!calls.some((c) => c.url.endsWith("/tweets") && c.init?.method === "POST"));
  await jarvis.decide(a.id, "approved");
  assert.ok(calls.some((c) => c.url.endsWith("/tweets") && c.init?.method === "POST"));
  const log = await store.activity.list({ agentId: "boo" });
  assert.ok(log.some((e) => /Posted from @philneeds: https:\/\/x.com\/philneeds\/status\/901/.test(e.summary)));
  const r = await jarvis.requestApproval({ agentId: "ncrypt", kind: "send", title: "dm", body: "", payload: { action: "x.dm", to: "77", text: "yo" } });
  await jarvis.decide(r.id, "approved");
  assert.ok(log.length >= 1 && (await store.activity.list({ agentId: "ncrypt" })).some((e) => /DM sent/.test(e.summary)));
});
