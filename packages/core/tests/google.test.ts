import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleConnector, memoryStore, Jarvis, ModelRouter, mockProvider, rawMail, bodyText } from "../src/index.js";

function fakeGoogle() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let users = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const body = String(init?.body);
      return json(body.includes("grant_type=refresh_token") ? { access_token: "at2", expires_in: 3600 } : { access_token: "at1", refresh_token: "rt", expires_in: 3600, scope: "x" });
    }
    if (u.includes("/userinfo")) { users++; return json({ email: users === 1 ? "phil@example.com" : "info@jdpm.example.com" }); }
    if (u.includes("/calendar/v3/") && (init?.method ?? "GET") === "GET") return json({ items: [{ id: "e1", summary: "Smith kitchen walkthrough", start: { dateTime: "2026-11-04T14:00:00-05:00" }, end: { dateTime: "2026-11-04T15:00:00-05:00" }, location: "12 Oak St" }] });
    if (u.includes("/calendar/v3/") && init?.method === "POST") return json({ id: "e2", htmlLink: "https://calendar/e2" });
    if (u.includes("/calendar/v3/") && init?.method === "PATCH") return json({ id: "e1", summary: "Smith kitchen walkthrough", htmlLink: "https://calendar/e1" });
    if (u.includes("/calendar/v3/") && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (u.includes("/messages?q=")) return json({ messages: [{ id: "m1" }] });
    if (u.includes("/messages/m1")) return json({ id: "m1", snippet: "Can you send the quote?", payload: { headers: [{ name: "From", value: "smith@example.com" }, { name: "Subject", value: "Kitchen" }, { name: "Date", value: "Mon" }], mimeType: "text/plain", body: { data: Buffer.from("Hi Phil, can you send the quote?").toString("base64url") } } });
    if (u.endsWith("/drafts")) return json({ id: "d1" });
    if (u.endsWith("/messages/batchModify")) return new Response(null, { status: 204 });
    if (u.endsWith("/users/me/labels") && (init?.method ?? "GET") === "GET") return json({ labels: [{ id: "L1", name: "Receipts" }] });
    if (u.includes("/messages?q=") && u.includes("older_than")) return json({ messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
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
  assert.equal((await g.status()).email, "phil@example.com");
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

test("several Google accounts: pick by email, move and remove events", async () => {
  const store = memoryStore(); await store.init();
  const { f, calls } = fakeGoogle();
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: f });
  await g.exchangeCode("c1"); await g.exchangeCode("c2");
  const s = await g.status();
  assert.deepEqual(s.accounts.map((a) => a.email), ["phil@example.com", "info@jdpm.example.com"]);
  await g.searchMessages("from:smith", 5, "jdpm");
  await assert.rejects(g.listEvents({ account: "nobody" }), /No Google account matching/);
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("g")] } }) });
  jarvis.addConnector(g, GoogleConnector.promptHint());
  const mv = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Move the walkthrough to 3pm", body: "", payload: { action: "calendar.update", id: "e1", start: "2026-11-05T15:00:00-05:00", end: "2026-11-05T16:00:00-05:00" } });
  await jarvis.decide(mv.id, "approved");
  assert.ok(calls.some((c) => c.init?.method === "PATCH" && c.url.includes("/events/e1")));
  const rm = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Remove the Zoom", body: "", payload: { action: "calendar.delete", id: "e1", title: "CryptoMondays Zoom" } });
  await jarvis.decide(rm.id, "approved");
  assert.ok(calls.some((c) => c.init?.method === "DELETE" && c.url.includes("/events/e1")));
  await g.disconnect("info@jdpm.example.com");
  assert.equal((await g.status()).accounts.length, 1);
});

test("Monica changes Phil's own events directly; events with guests go to Phil", async () => {
  const store = memoryStore(); await store.init();
  const { f, calls } = fakeGoogle();
  const withGuests = (async (u: string | URL | Request, i?: RequestInit) => {
    // e9 is a meeting with someone else on it; e1 is Phil's own.
    if (String(u).includes("/events/e9") && (i?.method ?? "GET") === "GET") return new Response(JSON.stringify({ id: "e9", attendees: [{ email: "phil@example.com", self: true }, { email: "smith@example.com" }] }), { headers: { "content-type": "application/json" } });
    return f(u, i);
  }) as typeof fetch;
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: withGuests, personalCalendars: ["phil@example.com"], businessCalendars: { "info@jdpm.example.com": { venture: "JD PM", lead: "stella" } } });
  await g.exchangeCode("c1");
  const { CHARTERS } = await import("../src/index.js");
  for (const name of ["calendar_create_event", "calendar_update_event", "calendar_delete_event"]) {
    assert.ok(CHARTERS.monica!.tools!.includes(name), `monica has ${name}`);
    assert.ok(!CHARTERS.stella!.tools!.includes(name), `stella lacks ${name}`);
  }
  const tool = (n: string) => g.tools().find((t) => t.name === n)!;
  const ctx = { store, agentId: "monica" };
  // No approval queue involved: the tool writes and reports the new event.
  assert.match(await tool("calendar_create_event").handler({ title: "Dentist", start: "2026-11-10T09:00:00-05:00", end: "2026-11-10T10:00:00-05:00" }, ctx), /Added "Dentist".*\[e2\]/);
  const post = calls.find((c) => c.init?.method === "POST" && c.url.includes("/calendar/v3/"));
  assert.ok(post && !String(post.init?.body).includes("attendees"));
  assert.match(await tool("calendar_update_event").handler({ id: "e1", start: "2026-11-05T15:00:00-05:00", end: "2026-11-05T16:00:00-05:00" }, ctx), /Updated "Smith kitchen walkthrough" to 2026-11-05T15:00/);
  assert.ok(calls.some((c) => c.init?.method === "PATCH" && c.url.includes("/events/e1")));
  // Someone else is on e9: the tool refuses and points to the approval path; nothing is sent to Google.
  assert.match(await tool("calendar_update_event").handler({ id: "e9", start: "2026-11-05T15:00:00-05:00" }, ctx), /Not changed.*smith@example.com.*calendar\.update/);
  assert.match(await tool("calendar_delete_event").handler({ id: "e9", title: "Smith call" }, ctx), /Not removed.*calendar\.delete/);
  assert.ok(!calls.some((c) => c.url.includes("/events/e9") && c.init?.method !== "GET"));
  assert.match(await tool("calendar_delete_event").handler({ id: "e1", title: "Smith kitchen walkthrough" }, ctx), /Removed "Smith kitchen walkthrough"/);
  assert.ok(calls.some((c) => c.init?.method === "DELETE" && c.url.includes("/events/e1")));
  // Each change leaves a line Phil can read.
  const log = await store.activity.list({ agentId: "monica" });
  assert.ok(log.some((e) => /Monica added "Dentist"/.test(e.summary) && /phil@example.com/.test(e.summary)));
  assert.ok(log.some((e) => /Monica changed "Smith kitchen walkthrough" to 2026-11-05T15:00/.test(e.summary)));
  assert.ok(log.some((e) => /Monica removed "Smith kitchen walkthrough"/.test(e.summary)));
});

test("Monica's direct calendar changes stay on Phil's personal calendars; business calendars refuse", async () => {
  const store = memoryStore(); await store.init();
  const { f, calls } = fakeGoogle();
  // Business account connected first, so an implicit default must still land on the personal one.
  let n = 0;
  const order = (async (u: string | URL | Request, i?: RequestInit) => {
    if (String(u).includes("/userinfo")) { n++; return new Response(JSON.stringify({ email: n === 1 ? "info@jdpm.example.com" : "phil@example.com" }), { headers: { "content-type": "application/json" } }); }
    return f(u, i);
  }) as typeof fetch;
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: order, personalCalendars: ["phil@example.com"], businessCalendars: { "info@jdpm.example.com": { venture: "JD PM", lead: "stella" } } });
  await g.exchangeCode("c1"); await g.exchangeCode("c2");
  const tool = (name: string) => g.tools().find((t) => t.name === name)!;
  const ctx = { store, agentId: "monica" };
  const writes = () => calls.filter((c) => c.url.includes("/calendar/v3/") && (c.init?.method ?? "GET") !== "GET").length;
  // Writes to the business calendar refuse, name the lead and the approval path, and never reach Google.
  assert.match(await tool("calendar_create_event").handler({ title: "Tracy install", start: "2026-11-18T08:00:00-05:00", end: "2026-11-18T12:00:00-05:00", account: "info@jdpm.example.com" }, ctx), /Nothing changed: info@jdpm\.example\.com is JD PM's calendar.*Stella \(stella\).*calendar\.create/);
  assert.match(await tool("calendar_update_event").handler({ id: "e1", start: "2026-11-05T15:00:00-05:00", account: "jdpm" }, ctx), /Nothing changed.*JD PM.*calendar\.update/);
  assert.match(await tool("calendar_delete_event").handler({ id: "e1", account: "info@jdpm.example.com" }, ctx), /Nothing changed.*calendar\.delete/);
  assert.equal(writes(), 0);
  // No account given: the first personal calendar, not the first connected account.
  assert.match(await tool("calendar_create_event").handler({ title: "Gym", start: "2026-11-14T07:00:00-05:00", end: "2026-11-14T08:00:00-05:00" }, ctx), /Added "Gym"/);
  assert.equal(writes(), 1);
  const log = await store.activity.list({ agentId: "monica" });
  assert.ok(log.some((e) => /added "Gym".*phil@example\.com/.test(e.summary)));
  // Reading the business calendar still works.
  assert.match(await tool("calendar_list_events").handler({ account: "info@jdpm.example.com" }, ctx), /Smith kitchen walkthrough/);
});

test("the live personal-calendar list is Phil's two personal accounts", async () => {
  const { PERSONAL_CALENDARS, BUSINESS_CALENDARS } = await import("../src/index.js");
  assert.deepEqual(PERSONAL_CALENDARS, ["philneedsofficial@gmail.com", "pmarino9081@gmail.com"]);
  assert.deepEqual(Object.keys(BUSINESS_CALENDARS).sort(), ["info@jdpmrenovations.com", "pmarino@getproedge.com", "rangedotzone@gmail.com"]);
});

test("legacy single-account tokens are picked up", async () => {
  const store = memoryStore(); await store.init();
  await store.settings.set("google.tokens", { access_token: "at", refresh_token: "rt", expires_at: Date.now() + 100000, email: "old@example.com" });
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: fakeGoogle().f });
  assert.equal((await g.status()).email, "old@example.com");
});

test("inbox cleanup: senders overview, archive by query, trash waits, account limit per agent", async () => {
  const store = memoryStore(); await store.init();
  const { f, calls } = fakeGoogle();
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: f });
  await g.exchangeCode("c1"); await g.exchangeCode("c2");
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("g")] } }) });
  jarvis.addConnector(g, GoogleConnector.promptHint());
  const senders = jarvis.allTools().find((t) => t.name === "gmail_senders")!;
  assert.match(await senders.handler({ query: "category:promotions older_than:30d" }, { store, agentId: "oscar" }), /smith@example.com/);
  const { setAgentConfig } = await import("../src/index.js");
  await setAgentConfig(store, "monica", { rules: { autoApprove: ["record"], maxAutoDollars: 0 } });
  const arch = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Archive 3 old promos", body: "", payload: { action: "gmail.archive", query: "category:promotions older_than:30d", max: 100 } });
  assert.equal(arch.status, "approved");
  assert.ok(calls.some((c) => c.url.endsWith("/messages/batchModify") && String(c.init?.body).includes('"removeLabelIds":["INBOX"]')));
  const trash = await jarvis.requestApproval({ agentId: "monica", kind: "other", title: "Trash 3 old promos", body: "", payload: { action: "gmail.trash", query: "category:promotions older_than:30d" } });
  assert.equal(trash.status, "pending");
  // Stella fenced to the JD PM mailbox: the default account becomes that one, and the other is refused.
  await setAgentConfig(store, "stella", { accounts: ["info@jdpm.example.com"] });
  const accounts = jarvis.allTools().find((t) => t.name === "google_accounts")!;
  assert.match(await accounts.handler({}, { store, agentId: "stella" }), /^\(default\) info@jdpm.example.com$/);
  const search = jarvis.allTools().find((t) => t.name === "gmail_search")!;
  await assert.rejects(search.handler({ query: "x", account: "phil@example.com" }, { store, agentId: "stella" }), /No Google account matching/);
});

test("all-day events report their real last day", async () => {
  const store = memoryStore(); await store.init();
  const { f } = fakeGoogle();
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: (async (u: string | URL | Request, i?: RequestInit) => {
    if (String(u).includes("/calendar/v3/")) return new Response(JSON.stringify({ items: [{ id: "t1", summary: "Joe in Niagara Falls", start: { date: "2026-09-23" }, end: { date: "2026-11-05" } }] }), { headers: { "content-type": "application/json" } });
    return f(u, i);
  }) as typeof fetch });
  await g.exchangeCode("c1");
  const tool = jarvisTools(g).find((t) => t.name === "calendar_list_events")!;
  assert.match(await tool.handler({}, { store, agentId: "monica" }), /all day 2026-09-23 through 2026-11-04/);
});
function jarvisTools(g: GoogleConnector) { return g.tools(); }
