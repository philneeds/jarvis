import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, GoHighLevelConnector, CHARTERS } from "../src/index.js";

test("GoHighLevel: read-only calls with the v2 headers; contacts, conversations, pipeline, invoices and appointments read plainly", async () => {
  const store = memoryStore(); await store.init();
  const now = Date.parse("2026-11-06T15:00:00Z");
  const calls: { method: string; path: string; headers: Record<string, string>; body?: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const headers = init?.headers as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, headers, body: init?.body as string | undefined });
    if (headers.authorization !== "Bearer pit-abc") return new Response(JSON.stringify({ message: "Invalid JWT" }), { status: 401 });
    if (u.pathname === "/locations/loc1") return Response.json({ location: { name: "JD PM Renovations", city: "Rochester" } });
    if (u.pathname === "/contacts/search") return Response.json({ contacts: [{ id: "c1", firstName: "Ana", lastName: "Lopez", phone: "+15855550100", source: "Facebook", tags: ["kitchen"], dateAdded: "2026-11-05T14:00:00Z", city: "Rochester" }] });
    if (u.pathname === "/contacts/c1") return Response.json({ contact: { id: "c1", contactName: "Ana Lopez", phone: "+15855550100", address1: "12 Elm St", city: "Rochester" } });
    if (u.pathname === "/contacts/c1/notes") return Response.json({ notes: [{ body: "Wants quote by Friday", dateAdded: "2026-11-05T15:00:00Z" }] });
    if (u.pathname === "/conversations/search") return Response.json({ conversations: [{ id: "v1", contactId: "c1", fullName: "Ana Lopez", unreadCount: 1, lastMessageDirection: "inbound", lastMessageDate: 1762440000000, lastMessageType: "TYPE_SMS", lastMessageBody: "Any update on the quote?" }] });
    if (u.pathname === "/conversations/v1/messages") return Response.json({ messages: { messages: [{ id: "m2", direction: "inbound", body: "Any update on the quote?", dateAdded: "2026-11-06T14:40:00Z", messageType: "TYPE_SMS" }, { id: "m1", direction: "outbound", body: "Thanks Ana, sending it tomorrow", dateAdded: "2026-11-04T10:00:00Z", messageType: "TYPE_SMS" }] } });
    if (u.pathname === "/opportunities/pipelines") return Response.json({ pipelines: [{ id: "p1", name: "Jobs", stages: [{ id: "s1", name: "New lead" }, { id: "s2", name: "Quoted" }] }] });
    if (u.pathname === "/opportunities/search") return Response.json({ opportunities: [{ id: "o1", name: "Lopez kitchen", monetaryValue: 4200, status: "open", pipelineStageId: "s2", contact: { name: "Ana Lopez" }, updatedAt: "2026-11-05T16:00:00Z" }, { id: "o2", name: "Smith bath", monetaryValue: 9000, status: "open", pipelineStageId: "s1", contact: { name: "Bob Smith" }, updatedAt: "2026-11-06T09:00:00Z" }] });
    if (u.pathname === "/invoices/") return Response.json({ invoices: [{ _id: "i1", invoiceNumber: 17, name: "Lopez kitchen", status: "sent", total: 4200, amountDue: 2100, dueDate: "2026-11-20T00:00:00Z", contactDetails: { name: "Ana Lopez" } }] });
    if (u.pathname === "/calendars/events") return Response.json({ events: [{ id: "e1", title: "Install: Lopez kitchen", startTime: "2026-11-10T13:00:00Z", endTime: "2026-11-10T17:00:00Z", appointmentStatus: "confirmed", address: "12 Elm St" }] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const g = new GoHighLevelConnector(store, { apiKey: "pit-abc", locationId: "loc1", fetch: f, now: () => now });
  assert.equal(await g.check(), "Connected to JD PM Renovations, Rochester.");
  assert.equal(calls[0]!.headers.version, "2021-07-28");
  const t = (name: string) => g.tools().find((x) => x.name === name)!;
  const ctx = { store, agentId: "stella" };
  assert.match(await t("ghl_contacts").handler({ query: "ana" }, ctx), /\[c1\] Ana Lopez · \+15855550100 · source: Facebook · tags: kitchen · Rochester · added Nov 5/);
  assert.match(JSON.parse(calls.at(-1)!.body!).sort[0].field, /dateAdded/);
  assert.match(await t("ghl_contact").handler({ id: "c1" }, ctx), /Address: 12 Elm St, Rochester\nNotes: Nov 5, 10:00 AM: Wants quote by Friday/);
  assert.match(await t("ghl_conversations").handler({ unread: true }, ctx), /\[v1\] Ana Lopez · 1 unread · they wrote Nov 6, 9:40 AM \(sms\): "Any update on the quote\?" · contact c1/);
  assert.match(calls.at(-1)!.path, /status=unread/);
  assert.match(await t("ghl_messages").handler({ conversationId: "v1" }, ctx), /^Nov 4, 5:00 AM · US \(sms\): Thanks Ana[\s\S]*THEM \(sms\): Any update/);
  const pipe = await t("ghl_pipeline").handler({}, ctx);
  assert.match(pipe, /2 open opportunities, \$13,200 in all\./);
  assert.match(pipe, /Jobs › New lead \(1, \$9,000\):\n  \[o2\] Smith bath · Bob Smith · \$9,000/);
  assert.match(await t("ghl_invoices").handler({ status: "sent" }, ctx), /1 invoice \(sent\), \$2,100 still due\.\n\[i1\] #17 Lopez kitchen · Ana Lopez · \$4,200 total, \$2,100 due · sent · due 2026-11-20/);
  assert.match(await t("ghl_appointments").handler({ days: 7 }, ctx), /Nov 10, 8:00 AM–12:00 PM · Install: Lopez kitchen · confirmed · 12 Elm St/);
  assert.ok(calls.every((c) => c.method === "GET" || c.path === "/contacts/search"), "nothing writes");
  assert.deepEqual(Object.keys(g.executors()), ["ghl.message"], "the one write is a reply, and only after approval");
  const n = calls.length; await t("ghl_pipeline").handler({}, ctx); assert.equal(calls.length, n, "cached for a minute");
  assert.equal((await g.status()).lastFetch?.ok, true);
  const bad = new GoHighLevelConnector(store, { apiKey: "wrong", locationId: "loc1", fetch: f, now: () => now });
  assert.match(await bad.tools()[0]!.handler({}, ctx), /GoHighLevel: GoHighLevel refused the key \(Invalid JWT\)/);
  for (const id of ["stella", "karol", "stephanie", "brian"]) assert.ok(CHARTERS[id]!.tools!.some((x) => x.startsWith("ghl_")), `${id} reads GoHighLevel`);
});

test("a GoHighLevel reply waits for Phil, then goes out through the API on approval", async () => {
  const store = memoryStore(); await store.init();
  const sent: { path: string; version: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const h = init?.headers as Record<string, string>;
    if (u.pathname === "/contacts/c1") return Response.json({ contact: { id: "c1", contactName: "Ana Lopez", phone: "+15855550100" } });
    if (u.pathname === "/contacts/c1/notes") return Response.json({ notes: [] });
    if (u.pathname === "/conversations/messages" && init?.method === "POST") { sent.push({ path: u.pathname, version: h.version, body: JSON.parse(String(init.body)) }); return Response.json({ conversationId: "v1", messageId: "m9" }); }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const { Jarvis } = await import("../src/index.js");
  const jarvis = new Jarvis({ store });
  const g = new GoHighLevelConnector(store, { apiKey: "pit-abc", locationId: "loc1", fetch: f });
  jarvis.addConnector(g, GoHighLevelConnector.promptHint());
  const a = await jarvis.requestApproval({ agentId: "stephanie", kind: "send", title: "Reply to Ana", body: "Hi Ana, the quote is on its way tomorrow. Stephanie, JD PM", payload: { action: "ghl.message", contactId: "c1", type: "SMS" } });
  assert.equal(a.status, "pending", "a customer message waits for Phil");
  assert.equal((a.payload as { to?: string }).to, "Ana Lopez (+15855550100)", "the card names the person");
  assert.match(a.effect ?? "", /Sends this SMS to Ana Lopez/);
  assert.equal(sent.length, 0);
  const done = await jarvis.decide(a.id, "approved", "ok");
  assert.equal(done?.status, "approved");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.body, { type: "SMS", contactId: "c1", message: "Hi Ana, the quote is on its way tomorrow. Stephanie, JD PM" });
  assert.equal(sent[0]!.version, "2021-04-15");
  assert.match(done?.note ?? "", /Sent to Ana Lopez \(\+15855550100\) via GoHighLevel \(SMS\), message m9/);
  await g.sendMessage({ contactId: "c1", type: "whatsapp", message: "hi" });
  assert.equal(sent[1]!.body.type, "WhatsApp", "channel names are sent the way GoHighLevel spells them");
});
