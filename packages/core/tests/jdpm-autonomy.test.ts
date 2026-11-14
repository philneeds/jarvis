import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, CHARTERS, isOutbound } from "../src/index.js";

function make() {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  return { store, jarvis };
}

test("the JD PM team works inside GoHighLevel on its own; anything a customer sees still waits for Phil", async () => {
  for (const id of ["stella", "karol", "jake", "bill", "stephanie", "frog", "brian"]) assert.equal(CHARTERS[id]?.asksFor, "outbound", id);
  const { jarvis } = make();
  // Internal CRM writes go through, logged.
  const contact = await jarvis.requestApproval({ agentId: "karol", kind: "other", title: "Log Ana Lopez as a lead", body: "From a Facebook message.", payload: { action: "ghl.contact.create", name: "Ana Lopez", phone: "+15855550100", source: "Facebook" } });
  assert.equal(contact.status, "approved");
  const deal = await jarvis.requestApproval({ agentId: "jake", kind: "other", title: "Lopez kitchen to Quoted", body: "Quote went out today.", payload: { action: "ghl.deal.move", opportunityId: "o1", stage: "Quoted" } });
  assert.equal(deal.status, "approved");
  const note = await jarvis.requestApproval({ agentId: "stephanie", kind: "other", title: "Note on Ana Lopez", body: "Install moved to the 12th.", payload: { action: "ghl.note", contactId: "c1", body: "Install moved to the 12th at her request." } });
  assert.equal(note.status, "approved");
  // A message to the customer, an email, or an action nobody recognises: Phil decides.
  const sms = await jarvis.requestApproval({ agentId: "stephanie", kind: "send", title: "Reply to Ana", body: "Hi Ana, yes: Friday works.", payload: { action: "ghl.message", contactId: "c1", type: "SMS", message: "Hi Ana, yes: Friday works." } });
  assert.equal(sms.status, "pending");
  const mail = await jarvis.requestApproval({ agentId: "karol", kind: "send", title: "First reply", body: "Thanks for reaching out.", payload: { action: "gmail.send", to: "ana@example.com", subject: "Your kitchen", body: "Thanks for reaching out." } });
  assert.equal(mail.status, "pending");
  const odd = await jarvis.requestApproval({ agentId: "jake", kind: "other", title: "Something new", body: "", payload: { action: "ghl.invoice.send", id: "i1" } });
  assert.equal(odd.status, "pending", "an action HQ doesn't know is treated as outbound");
  const money = await jarvis.requestApproval({ agentId: "brian", kind: "money", title: "Pay the lumber bill", body: "$1,240", payload: { action: "record.update", amount: 1240 } });
  assert.equal(money.status, "pending", "money always waits");
  assert.equal(isOutbound({ kind: "other", payload: { action: "ghl.deal.create", name: "x" } }), false);
  assert.equal(isOutbound({ kind: "send", payload: { action: "ghl.message", contactId: "c1" } }), true);
});

test("no agent can get a trade, an order or a business-calendar change auto-approved by labelling the card 'record'", async () => {
  const { jarvis } = make();
  for (const [agentId, payload] of [
    ["stella", { action: "robinhood.call", tool: "place_order", args: { symbol: "TSLA", qty: 10 } }],
    ["monica", { action: "trade.execute", symbol: "ETH", side: "long", sizeUsd: 500 }],
    ["lip", { action: "strategy.enable", name: "yolo" }],
    ["karol", { action: "trade.close", positionId: "p1", pnlUsd: -300 }],
    ["jake", { action: "ghl.invoice.send", id: "i1" }],
    ["monica", { action: "calendar.delete", id: "e1", account: "pmarino@getproedge.com" }],
    ["monica", { action: "calendar.update", id: "e1", account: "philneedsofficial@gmail.com", start: "2026-11-20T10:00:00" }],
    ["monica", { action: "calendar.create", title: "Ops sync", start: "2026-11-20T10:00:00", end: "2026-11-20T11:00:00", account: "rangedotzone@gmail.com" }],
    ["monica", { action: "calendar.create", title: "Gym", start: "2026-11-20T10:00:00", end: "2026-11-20T11:00:00" }],
  ] as const) {
    const a = await jarvis.requestApproval({ agentId, kind: "record", title: `t ${payload.action}`, body: "", payload: { ...payload } });
    assert.equal(a.status, "pending", `${agentId} ${payload.action} ${"account" in payload ? payload.account : ""}`);
  }
  // Still fine: a guest-free new event on a personal calendar, named; an archive; a record with no action (only records the decision).
  const gym = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Gym", body: "", payload: { action: "calendar.create", title: "Gym", start: "2026-11-20T10:00:00", end: "2026-11-20T11:00:00", account: "PMarino9081@gmail.com" } });
  assert.notEqual(gym.status, "pending");
  const arch = await jarvis.requestApproval({ agentId: "monica", kind: "other", title: "Archive promos", body: "", payload: { action: "gmail.archive", query: "category:promotions", max: 20 } });
  assert.notEqual(arch.status, "pending");
});
