import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleConnector, memoryStore, Jarvis, ModelRouter, mockProvider, rawMail, bodyText } from "../src/index.js";

function fakeGoogle() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const body = String(init?.body);
      return json(body.includes("grant_type=refresh_token") ? { access_token: "at2", expires_in: 3600 } : { access_token: "at1", refresh_token: "rt", expires_in: 3600, scope: "x" });
    }
    if (u.includes("/userinfo")) return json({ email: "phil@example.com" });
    if (u.includes("/calendar/v3/") && (init?.method ?? "GET") === "GET") return json({ items: [{ id: "e1", summary: "Smith kitchen walkthrough", start: { dateTime: "2026-11-04T14:00:00-05:00" }, end: { dateTime: "2026-11-04T15:00:00-05:00" }, location: "12 Oak St" }] });
    if (u.includes("/calendar/v3/") && init?.method === "POST") return json({ id: "e2", htmlLink: "https://calendar/e2" });
    if (u.includes("/messages?q=")) return json({ messages: [{ id: "m1" }] });
    if (u.includes("/messages/m1")) return json({ id: "m1", snippet: "Can you send the quote?", payload: { headers: [{ name: "From", value: "smith@example.com" }, { name: "Subject", value: "Kitchen" }, { name: "Date", value: "Mon" }], mimeType: "text/plain", body: { data: Buffer.from("Hi Phil, can you send the quote?").toString("base64url") } } });
    if (u.endsWith("/drafts")) return json({ id: "d1" });
    if (u.endsWith("/messages/send")) return json({ id: "sent1" });
    return json({ error: "unexpected " + u }, 500);
  }) as typeof fetch;
  return { f, calls };
}

test("OAuth exchange, refresh, calendar and gmail reads", async () => {
  const store = memoryStore(); await store.init();
  const { f, calls } = fakeGoogle();
  let now = 1_000_000;
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: f, now: () => now });
  assert.match(g.authUrl("abc"), /accounts\.google\.com.*state=abc/);
  assert.equal((await g.status()).connected, false);
  await g.exchangeCode("code");
  assert.deepEqual(await g.status(), { connected: true, email: "phil@example.com" });
  const ev = await g.listEvents();
  assert.equal(ev[0]!.title, "Smith kitchen walkthrough");
  now += 2 * 3600 * 1000; // token expired → refresh
  const ms = await g.searchMessages("from:smith");
  assert.equal(ms[0]!.subject, "Kitchen");
  assert.ok(calls.some((c) => String(c.init?.body).includes("grant_type=refresh_token")));
  const full = await g.getMessage("m1");
  assert.match(full.body!, /send the quote/);
});

test("tools and approval executors go through Jarvis", async () => {
  const store = memoryStore(); await store.init();
  const { f, calls } = fakeGoogle();
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: f });
  await g.exchangeCode("code");
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  jarvis.addConnector(g, GoogleConnector.promptHint());
  assert.ok(jarvis.allTools().some((t) => t.name === "gmail_search"));
  const cal = jarvis.allTools().find((t) => t.name === "calendar_list_events")!;
  assert.match(await cal.handler({}, { store, agentId: "monica" }), /Smith kitchen walkthrough/);
  // A send waits for Phil, then the executor actually sends.
  const a = await jarvis.requestApproval({ agentId: "stephanie", kind: "send", title: "Reply to the Smiths", body: "…", payload: { action: "gmail.send", to: "smith@example.com", subject: "Your quote", body: "Attached." } });
  assert.equal(a.status, "pending");
  assert.ok(!calls.some((c) => c.url.endsWith("/messages/send")));
  await jarvis.decide(a.id, "approved");
  assert.ok(calls.some((c) => c.url.endsWith("/messages/send")));
  const log = await store.activity.list({ agentId: "stephanie" });
  assert.ok(log.some((e) => /Email sent to smith@example.com/.test(e.summary)));
  // Drafts need no approval.
  const draft = jarvis.allTools().find((t) => t.name === "gmail_create_draft")!;
  assert.match(await draft.handler({ to: "a@b.c", subject: "s", body: "b" }, { store, agentId: "stephanie" }), /Draft saved/);
});

test("mail encoding helpers", () => {
  const raw = rawMail({ to: "a@b.c", subject: "Hi", body: "Line" });
  assert.match(Buffer.from(raw, "base64url").toString(), /To: a@b.c\r\nSubject: Hi/);
  assert.equal(bodyText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: Buffer.from("<b>x</b>").toString("base64url") } }, { mimeType: "text/plain", body: { data: Buffer.from("plain").toString("base64url") } }] }), "plain");
});
