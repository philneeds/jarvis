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
    // GoHighLevel answers events for one calendar at a time (422 without calendarId, userId or groupId).
    if (u.pathname === "/calendars/") return Response.json({ calendars: [{ id: "cal1", name: "Estimates" }, { id: "cal2", name: "Installs" }] });
    if (u.pathname === "/calendars/events") {
      const cal = u.searchParams.get("calendarId");
      if (!cal) return Response.json({ statusCode: 422, message: ["Either of calendarId, userId or groupId is required"] }, { status: 422 });
      return Response.json({ events: cal === "cal2" ? [{ id: "e1", title: "Install: Lopez kitchen", startTime: "2026-11-10T13:00:00Z", endTime: "2026-11-10T17:00:00Z", appointmentStatus: "confirmed", address: "12 Elm St" }] : [{ id: "e2", title: "Estimate: Smith bath", startTime: "2026-11-09T15:00:00Z", endTime: "2026-11-09T16:00:00Z", appointmentStatus: "confirmed" }] });
    }
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
  const appts = await t("ghl_appointments").handler({ days: 7 }, ctx);
  assert.match(appts, /^Nov 9, 10:00 AM–11:00 AM · Estimate: Smith bath · confirmed · Estimates\nNov 10, 8:00 AM–12:00 PM · Install: Lopez kitchen · confirmed · Installs · 12 Elm St$/, "every calendar, merged and in order, each event naming its calendar");
  const evCalls = calls.filter((c) => c.path.startsWith("/calendars/events"));
  assert.deepEqual(evCalls.map((c) => new URL(`http://x${c.path}`).searchParams.get("calendarId")), ["cal1", "cal2"], "one events call per calendar, each with its calendarId");
  assert.ok(evCalls.every((c) => c.headers.version === "2021-04-15"), "the calendars API's version");
  assert.ok(calls.every((c) => c.method === "GET" || c.path === "/contacts/search"), "nothing writes");
  assert.deepEqual(Object.keys(g.executors()), ["ghl.contact.create", "ghl.note", "ghl.deal.create", "ghl.deal.move", "ghl.appointment.create", "ghl.message"], "every write waits for approval");
  const n = calls.length; await t("ghl_pipeline").handler({}, ctx); assert.equal(calls.length, n, "cached for a minute");
  assert.equal((await g.status()).lastFetch?.ok, true);
  const bad = new GoHighLevelConnector(store, { apiKey: "wrong", locationId: "loc1", fetch: f, now: () => now });
  assert.match(await bad.tools()[0]!.handler({}, ctx), /GoHighLevel: GoHighLevel refused the key \(Invalid JWT\)/);
  assert.equal((await bad.status()).lastFetch?.ok, false, "a bad key is a lost connection");
  for (const id of ["stella", "karol", "stephanie", "brian"]) assert.ok(CHARTERS[id]!.tools!.some((x) => x.startsWith("ghl_")), `${id} reads GoHighLevel`);
});

test("a token missing a scope names the scope to add in GoHighLevel and doesn't count as a lost connection (Nov 19: texts and a contact refused with 401 'not authorized for this scope' while a deal move went through)", async () => {
  const store = memoryStore(); await store.init();
  const { scopeFor } = await import("../src/connectors/gohighlevel.js");
  assert.equal(scopeFor("POST", "/conversations/messages"), "conversations/message.write");
  assert.equal(scopeFor("GET", "/conversations/v1/messages?limit=30"), "conversations/message.readonly");
  assert.equal(scopeFor("POST", "/contacts/"), "contacts.write");
  assert.equal(scopeFor("POST", "/contacts/c1/notes"), "contacts.write");
  assert.equal(scopeFor("GET", "/calendars/?locationId=loc1"), "calendars.readonly");
  assert.equal(scopeFor("GET", "/calendars/events?x=1"), "calendars/events.readonly");
  assert.equal(scopeFor("POST", "/calendars/events/appointments"), "calendars/events.write");
  assert.equal(scopeFor("PUT", "/opportunities/o1"), "opportunities.write");
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const m = init?.method ?? "GET";
    if (u.pathname === "/locations/loc1") return Response.json({ location: { name: "JD PM Renovations" } });
    if (u.pathname === "/contacts/c1") return Response.json({ contact: { id: "c1", contactName: "Ana Lopez", phone: "+1585" } });
    if (u.pathname === "/contacts/c1/notes" && m === "GET") return Response.json({ notes: [] });
    // The token has opportunities.write but not contacts.write, calendars.readonly or conversations/message.write.
    if (u.pathname === "/opportunities/pipelines") return Response.json({ pipelines: [{ id: "p1", name: "Jobs", stages: [{ id: "s1", name: "New lead" }] }] });
    if (u.pathname === "/opportunities/o1" && m === "PUT") return Response.json({ succeded: true });
    return Response.json({ statusCode: 401, message: "The token is not authorized for this scope." }, { status: 401 });
  }) as typeof fetch;
  const { Jarvis } = await import("../src/index.js");
  const jarvis = new Jarvis({ store });
  const g = new GoHighLevelConnector(store, { apiKey: "pit-abc", locationId: "loc1", fetch: f });
  jarvis.addConnector(g, GoHighLevelConnector.promptHint());
  assert.equal(await g.check(), "Connected to JD PM Renovations.");
  const ctx = { store, agentId: "bill" };
  assert.match(await g.tools().find((x) => x.name === "ghl_appointments")!.handler({}, ctx), /^GoHighLevel: GoHighLevel's token lacks the calendars\.readonly scope \(401: The token is not authorized for this scope\.\)\. Add it in GoHighLevel under Settings › Private Integrations › ⋮ Edit; the token stays the same\.$/);
  assert.equal((await g.status()).lastFetch?.ok, true, "a missing scope isn't a refused key: GoHighLevel stays connected");
  const sms = await jarvis.requestApproval({ agentId: "karol", kind: "send", title: "First text to Ana", body: "Hi Ana", payload: { action: "ghl.message", contactId: "c1", type: "SMS", message: "Hi Ana" } });
  assert.match((await jarvis.decide(sms.id, "approved"))?.note ?? "", /GoHighLevel refused to send: GoHighLevel's token lacks the conversations\/message\.write scope \(401/);
  const made = await jarvis.requestApproval({ agentId: "karol", kind: "other", title: "New lead", body: "x", payload: { action: "ghl.contact.create", name: "Bob Smith", phone: "+15855550199" } });
  assert.match(made.note ?? "", /GoHighLevel refused: GoHighLevel's token lacks the contacts\.write scope \(401/);
  const mv = await jarvis.requestApproval({ agentId: "jake", kind: "other", title: "Won", body: "x", payload: { action: "ghl.deal.move", opportunityId: "o1", stage: "New lead", status: "won" } });
  assert.match(mv.note ?? "", /Moved deal o1 to New lead \(won\)/, "the scope it does have still works");
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

test("GoHighLevel's internal writes go through on their own for the JD PM team (a contact, a note, a deal created and moved); a message to the customer waits for Phil", async () => {
  const store = memoryStore(); await store.init();
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const m = init?.method ?? "GET";
    if (u.pathname === "/contacts/c1") return Response.json({ contact: { id: "c1", contactName: "Ana Lopez", phone: "+1585" } });
    if (u.pathname === "/contacts/c1/notes" && m === "GET") return Response.json({ notes: [] });
    if (u.pathname === "/opportunities/pipelines") return Response.json({ pipelines: [{ id: "p1", name: "Jobs", stages: [{ id: "s1", name: "New lead" }, { id: "s2", name: "Quoted" }] }] });
    if (m === "POST" || m === "PUT") { writes.push({ method: m, path: u.pathname, body: JSON.parse(String(init?.body)) }); return Response.json(u.pathname === "/contacts/" ? { contact: { id: "c9" } } : { opportunity: { id: "o9" } }); }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const { Jarvis } = await import("../src/index.js");
  const jarvis = new Jarvis({ store });
  const g = new GoHighLevelConnector(store, { apiKey: "pit-abc", locationId: "loc1", fetch: f });
  jarvis.addConnector(g, GoHighLevelConnector.promptHint());
  const ask = (agentId: string, title: string, payload: Record<string, unknown>) => jarvis.requestApproval({ agentId, kind: "other", title, body: "why", payload });
  // Phil's rule for the JD PM team (asksFor "outbound"): CRM work that reaches nobody outside JD PM goes through at once, logged.
  const c = await ask("karol", "New lead: Bob Smith", { action: "ghl.contact.create", name: "Bob Smith", phone: "+15855550199", source: "Facebook", tags: ["bath"] });
  assert.equal(c.status, "approved", "a contact record reaches nobody: Karol creates it on her own");
  assert.match(c.effect ?? "", /Creates Bob Smith \(\+15855550199\) as a contact.*source Facebook/);
  assert.deepEqual(writes[0], { method: "POST", path: "/contacts/", body: { locationId: "loc1", firstName: "Bob", lastName: "Smith", phone: "+15855550199", source: "Facebook", tags: ["bath"] } });
  assert.ok((await store.activity.list({ agentId: "karol" })).some((e) => /auto-approved by Phil's rule/.test(e.summary)));
  const n = await ask("stephanie", "Note on Ana", { action: "ghl.note", contactId: "c1", body: "Wants the install after Thanksgiving" });
  assert.equal((n.payload as { to?: string }).to, "Ana Lopez (+1585)", "the record still names the contact");
  assert.equal(n.status, "approved");
  assert.deepEqual(writes[1], { method: "POST", path: "/contacts/c1/notes", body: { body: "Wants the install after Thanksgiving" } });
  const d = await ask("jake", "Quote sent", { action: "ghl.deal.create", name: "Lopez kitchen", contactId: "c1", stage: "Quoted", value: 4200 });
  assert.equal(d.status, "approved");
  assert.deepEqual(writes[2], { method: "POST", path: "/opportunities/", body: { pipelineId: "p1", locationId: "loc1", name: "Lopez kitchen", pipelineStageId: "s2", status: "open", contactId: "c1", monetaryValue: 4200 } });
  const mv = await ask("jake", "Won", { action: "ghl.deal.move", opportunityId: "o9", name: "Lopez kitchen", stage: "Quoted", status: "won" });
  assert.deepEqual(writes[3], { method: "PUT", path: "/opportunities/o9", body: { pipelineStageId: "s2", status: "won" } });
  assert.match(mv.note ?? "", /Moved Lopez kitchen to Quoted \(won\)/);
  const bad = await ask("jake", "Nope", { action: "ghl.deal.move", opportunityId: "o9", stage: "Installed" });
  assert.match(bad.note ?? "", /No stage "Installed" in Jobs; stages are New lead, Quoted/);
  // A message to the customer is outbound: it waits, and nothing is sent until Phil approves.
  const sms = await jarvis.requestApproval({ agentId: "stephanie", kind: "send", title: "Reply to Ana", body: "Friday works.", payload: { action: "ghl.message", contactId: "c1", type: "SMS", message: "Friday works." } });
  assert.equal(sms.status, "pending");
  assert.equal(writes.length, 4);
  // Nov 21, Myra Morgan: one card makes the contact, the note, the deal, and marks it won using the deal step 3 made.
  const card = await jarvis.requestApproval({ agentId: "stella", kind: "record", title: "Myra Morgan: add to GHL, mark carport sale won", body: "why", payload: { action: "batch", steps: [
    { action: "ghl.contact.create", name: "Myra Morgan", phone: "+15855550123" },
    { action: "ghl.note", contactId: "$step1.contactId", body: "Signed Nov 18: $4,888 down of $9,776." },
    { action: "ghl.deal.create", name: "Myra Morgan carport", contactId: "$step1.contactId", stage: "Quoted", value: 9776 },
    { action: "ghl.deal.move", opportunityId: "$step3.opportunityId", name: "Myra Morgan carport", stage: "Quoted", status: "won" },
  ] } });
  if (card.status === "pending") await jarvis.decide(card.id, "approved");
  assert.deepEqual(writes.slice(4).map((w) => `${w.method} ${w.path}`), ["POST /contacts/", "POST /contacts/c9/notes", "POST /opportunities/", "PUT /opportunities/o9"], "every step ran, each with what the one before made");
  assert.equal(writes[6]!.body.contactId, "c9");
  assert.equal(writes[7]!.body.status, "won");
  // Or in one step: a deal can start won, with the amount written as text.
  const won = await ask("jake", "Signed", { action: "ghl.deal.create", name: "Kim roof", contactId: "c1", stage: "Quoted", value: "$12,500", status: "won" });
  assert.equal(won.status, "approved");
  assert.deepEqual(writes.at(-1)!.body, { pipelineId: "p1", locationId: "loc1", name: "Kim roof", pipelineStageId: "s2", status: "won", contactId: "c1", monetaryValue: 12500 });
  assert.match(won.note ?? "", /Deal "Kim roof" created in GoHighLevel at Quoted, won at \$12,500 \(o9\)/);
});

test("an appointment booked by phone goes on the GoHighLevel calendar, with the customer added first when they're new", async () => {
  const { Jarvis, easternIso } = await import("../src/index.js");
  // Eastern time with the offset that day has: EST in November, EDT in July.
  assert.equal(easternIso("11/20/2026", "2:00 PM"), "2026-11-20T14:00:00-05:00");
  assert.equal(easternIso("2026-07-01", "9am", 90), "2026-07-01T10:30:00-04:00");
  assert.equal(easternIso("11/20/2026", "12:30 am"), "2026-11-20T00:30:00-05:00");
  assert.equal(easternIso("tomorrow", "2pm"), undefined);
  // Reviewer, Nov 18: no AM/PM is a guess, and a date that doesn't exist isn't rolled forward.
  assert.equal(easternIso("11/20/2026", "2:00"), undefined, "2:00 could be 2 AM or 2 PM");
  assert.equal(easternIso("11/20/2026", "14:00"), "2026-11-20T14:00:00-05:00", "24-hour time is fine");
  assert.equal(easternIso("02/30/2026", "2pm"), undefined);
  assert.equal(easternIso("11/20/2026", "13pm"), undefined);
  const store = memoryStore(); await store.init();
  const writes: { path: string; version: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const m = init?.method ?? "GET"; const h = init?.headers as Record<string, string>;
    if (u.pathname === "/calendars/") return Response.json({ calendars: [{ id: "cal1", name: "Estimates" }, { id: "cal2", name: "Installs" }, { id: "cal3", name: "Old", isActive: false }] });
    if (u.pathname === "/contacts/search") { const q = JSON.parse(String(init?.body)).query; return Response.json({ contacts: q === "5855550100" ? [{ id: "c1", firstName: "Ana", lastName: "Lopez", phone: "+1 (585) 555-0100" }] : [] }); }
    if (m === "POST") { const body = JSON.parse(String(init?.body)); writes.push({ path: u.pathname, version: h.version, body }); return Response.json(u.pathname === "/contacts/" ? { contact: { id: "c9" } } : { id: "appt1" }); }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const jarvis = new Jarvis({ store });
  const g = new GoHighLevelConnector(store, { apiKey: "pit-abc", locationId: "loc1", fetch: f });
  jarvis.addConnector(g, GoHighLevelConnector.promptHint());
  // A new customer from a phone call: one card adds them and books them.
  const card = await jarvis.requestApproval({ agentId: "stella", kind: "other", title: "Book Loneice Sabree", body: "She called; estimate Friday 2 pm", payload: { action: "ghl.appointment.create", name: "Loneice Sabree", phone: "(585) 498-5340", address: "8 Oak St, Rochester", date: "11/20/2026", time: "2:00 PM", calendar: "estimates", notes: "Kitchen estimate" } });
  assert.equal(card.status, "pending", "an appointment waits for Phil");
  assert.match(card.effect ?? "", /Books Loneice Sabree \(\(585\) 498-5340\) on JD PM's GoHighLevel calendar "estimates" for 11\/20\/2026 at 2:00 PM \(60 min\), at 8 Oak St, Rochester\. If they aren't a contact yet, they're added first\. Nothing is sent to the customer\./);
  assert.equal(writes.length, 0, "nothing written before Phil approves");
  const done = await jarvis.decide(card.id, "approved");
  assert.deepEqual(writes.map((w) => w.path), ["/contacts/", "/calendars/events/appointments"]);
  assert.deepEqual(writes[0]!.body, { locationId: "loc1", firstName: "Loneice", lastName: "Sabree", phone: "(585) 498-5340", source: "Phone call", address1: "8 Oak St, Rochester" });
  assert.deepEqual(writes[1]!.body, { calendarId: "cal1", locationId: "loc1", contactId: "c9", startTime: "2026-11-20T14:00:00-05:00", endTime: "2026-11-20T15:00:00-05:00", title: "Loneice Sabree · 8 Oak St, Rochester", appointmentStatus: "confirmed", address: "8 Oak St, Rochester", description: "Kitchen estimate", ignoreFreeSlotValidation: true, ignoreDateRange: true, toNotify: false });
  assert.equal(writes[1]!.version, "2021-04-15", "the calendars API's version");
  assert.match(done?.note ?? "", /Booked "Loneice Sabree · 8 Oak St, Rochester" on Estimates for Nov 20, 2:00 PM \(60 min\), appointment appt1\. Added Loneice Sabree as a new contact\. No message went to the customer\./);
  // An existing customer, found by phone: no second contact. Two calendars and none named: asked, not guessed.
  writes.length = 0;
  const again = await jarvis.requestApproval({ agentId: "stella", kind: "other", title: "Book Ana", body: "x", payload: { action: "ghl.appointment.create", name: "Ana Lopez", phone: "585-555-0100", date: "11/21/2026", time: "9am", durationMinutes: 120, calendar: "Installs" } });
  const d2 = await jarvis.decide(again.id, "approved");
  assert.deepEqual(writes.map((w) => w.path), ["/calendars/events/appointments"], d2?.note);
  assert.equal(writes[0]!.body.contactId, "c1");
  assert.equal(writes[0]!.body.calendarId, "cal2");
  assert.equal(writes[0]!.body.endTime, "2026-11-21T11:00:00-05:00");
  const vague = await jarvis.requestApproval({ agentId: "stella", kind: "other", title: "Book", body: "x", payload: { action: "ghl.appointment.create", name: "Ana Lopez", phone: "585-555-0100", date: "11/21/2026", time: "9am" } });
  assert.match((await jarvis.decide(vague.id, "approved"))?.note ?? "", /^Failed to execute ghl\.appointment\.create: which calendar\? GoHighLevel has "Estimates", "Installs"/);
  // Reviewer, Nov 18: never the wrong customer or the wrong calendar.
  writes.length = 0;
  const fail = async (payload: Record<string, unknown>) => (await jarvis.decide((await jarvis.requestApproval({ agentId: "stella", kind: "other", title: "Book", body: "x", payload: { action: "ghl.appointment.create", date: "11/21/2026", time: "9am", calendar: "Installs", ...payload } })).id, "approved"))?.note ?? "";
  assert.match(await fail({ name: "Bob Jones", phone: "585-555-0100" }), /the phone 585-555-0100 belongs to Ana Lopez in GoHighLevel, not Bob Jones/, "a number on someone else's record");
  assert.match(await fail({ name: "Bob Jones", phone: "555-0100" }), /isn't a full 10-digit phone number/, "seven digits match people in every area code");
  assert.match(await fail({ name: "Ana Lopez", phone: "585-555-0100", calendar: "s" }), /"s" fits "Estimates" and "Installs"; name the one you mean/);
  assert.match(await fail({ name: "Ana Lopez", phone: "585-555-0100", calendar: "Roofing" }), /no calendar called "Roofing" in GoHighLevel; it has "Estimates", "Installs"/);
  assert.match(await fail({ name: "Ana Lopez", phone: "585-555-0100", time: "2:00" }), /needs a date \(MM\/DD\/YYYY\) and a time/);
  assert.equal(writes.length, 0, "none of those wrote anything");
});
