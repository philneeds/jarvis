import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider } from "../src/index.js";
import { editBatch, setStepResult, stepForDisplay } from "../src/jarvis/batch.js";
import { alwaysWaits, isOutbound } from "../src/jarvis/rules.js";

function make() {
  const store = memoryStore();
  const router = new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } });
  return { store, jarvis: new Jarvis({ store, router }) };
}

test("a batch card runs every step, passes a new contact's id on, and flags the step that failed", async () => {
  const { jarvis } = make();
  const made: string[] = [], notes: string[] = [];
  jarvis.onApproved("ghl.contact.create", async (a) => {
    const name = String(a.payload?.name);
    if (name === "Bad Row") throw new Error("GoHighLevel refused (400)");
    made.push(name);
    setStepResult(a, { contactId: `id-${name.split(" ")[0]}` });
    return `Created ${name}.`;
  });
  jarvis.onApproved("ghl.note", async (a) => { notes.push(`${String(a.payload?.contactId)}: ${a.body}`); return "Note added."; });
  // Stella's Nov 20 shape: "actions", and the note points at step 1's contact.
  const card = await jarvis.requestApproval({ agentId: "stella", kind: "other", title: "GHL: add 3 Leap customers + note", body: "Create 3 contacts, then note Myra's second number.", payload: { action: "batch", actions: [
    { action: "ghl.contact.create", name: "Myra Morgan", phone: "585-704-7078" },
    { action: "ghl.contact.create", name: "Loneice Sabree" },
    { action: "ghl.contact.create", name: "Jesus Alicea" },
    { action: "ghl.note", contactId: "$step1.contactId", body: "Second phone: 716-954-3175." },
  ] } });
  // All-internal GoHighLevel steps fall under the same "only outbound waits" rule a single contact card does.
  assert.match(card.effect!, /Runs 4 steps/);
  assert.equal(stepForDisplay({ action: "ghl.note", contactId: "$step1.contactId" }).contactId, "the contact from step 1");
  const done = card.status === "pending" ? await jarvis.decide(card.id, "approved") : card;
  assert.deepEqual(made, ["Myra Morgan", "Loneice Sabree", "Jesus Alicea"]);
  assert.deepEqual(notes, ["id-Myra: Second phone: 716-954-3175."]);
  assert.match(done!.note!, /All 4 steps done/);

  // The first failure stops the card: what went through and what never ran are both on it.
  const two = await jarvis.requestApproval({ agentId: "stella", kind: "other", title: "GHL: three more", body: "", payload: { action: "batch", steps: [
    { action: "ghl.contact.create", name: "First Row" },
    { action: "ghl.contact.create", name: "Bad Row" },
    { action: "ghl.contact.create", name: "Good Row" },
    { action: "ghl.note", contactId: "$step2.contactId", body: "x" },
  ] } });
  const res = two.status === "pending" ? await jarvis.decide(two.id, "approved") : two;
  assert.ok(made.includes("First Row"));
  assert.ok(!made.includes("Good Row"));
  assert.match(res!.note!, /Failed to execute batch: stopped at step 2 of 4: 1 went through, 2 not run/);
  assert.match(res!.note!, /1\. Done: Created First Row/);
  assert.match(res!.note!, /2\. FAILED \(ghl\.contact\.create\): GoHighLevel refused/);
  assert.match(res!.note!, /3\. Not run: ghl\.contact\.create/);
  assert.match(res!.note!, /4\. Not run: ghl\.note/);
});

test("Phil's Edit on a batch card reaches the step it's about", async () => {
  const { jarvis } = make();
  const notes: string[] = [];
  jarvis.onApproved("ghl.contact.create", async (a) => { setStepResult(a, { contactId: "c-new" }); return "made"; });
  jarvis.onApproved("ghl.message", async (a) => { notes.push(`${String(a.payload?.contactId)}: ${String(a.payload?.message)}`); return "sent"; });
  // A text to the customer is in it, so the card waits for Phil the way that text alone would.
  const card = await jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Myra", body: "Hi Myra, welcome.", payload: { action: "batch", steps: [
    { action: "ghl.contact.create", name: "Myra Morgan", phone: "585-704-7078" },
    { action: "ghl.message", contactId: "$step1.contactId", type: "SMS", message: "Hi Myra, welcome." },
  ] } });
  assert.equal(card.status, "pending");
  // Plain text goes to the one step that carries text: the message.
  const done = await jarvis.decide(card.id, "edited", undefined, { body: "Hi Myra, welcome to JD PM." });
  assert.deepEqual(notes, ["c-new: Hi Myra, welcome to JD PM."]);
  assert.match(done!.note!, /All 2 steps done/);
  // Pasted JSON replaces the steps.
  assert.deepEqual(editBatch({ action: "batch", steps: [{ action: "ghl.note", body: "a" }] }, `[{"action":"ghl.note","contactId":"c1","body":"b"}]`).steps, [{ action: "ghl.note", contactId: "c1", body: "b" }]);
  // Two text steps and plain text: the steps stay as they were.
  const two = { action: "batch", steps: [{ action: "ghl.note", body: "a" }, { action: "ghl.note", body: "b" }] };
  assert.deepEqual(editBatch(two, "c").steps, two.steps);
});

test("a batch card is checked step by step when it's filed, and waits if any step would", async () => {
  const { jarvis } = make();
  jarvis.onApproved("ghl.note", async () => "ok");
  // A step no connector handles is refused at filing, not discovered after Phil approves.
  const r = await jarvis.requestApproval({ agentId: "stella", kind: "other", title: "mixed", body: "", payload: { action: "batch", steps: [{ action: "ghl.note", contactId: "c1", body: "x" }, { action: "nope.thing" }] } });
  assert.equal(r.status, "rejected");
  assert.match(r.note!, /step 2: no connector handles "nope.thing"/);
  // A list of actions with no "action" becomes a batch card instead of one that does nothing.
  const s = await jarvis.requestApproval({ agentId: "stella", kind: "other", title: "list", body: "", payload: { actions: [{ action: "ghl.note", contactId: "c1", body: "x" }] } });
  assert.equal((s.payload as { action?: string }).action, "batch");
  // Outbound or money anywhere in the batch makes the whole card wait for Phil.
  const internal = { kind: "other" as const, payload: { action: "batch", steps: [{ action: "ghl.note" }, { action: "ghl.contact.create" }] } };
  assert.equal(isOutbound(internal), false);
  assert.equal(isOutbound({ kind: "other", payload: { action: "batch", steps: [{ action: "ghl.note" }, { action: "ghl.message" }] } }), true);
  assert.equal(alwaysWaits(internal), false);
  assert.equal(alwaysWaits({ kind: "other", payload: { action: "batch", steps: [{ action: "ghl.note" }, { action: "eagleview.order" }] } }), true);
  assert.equal(isOutbound({ kind: "other", payload: { action: "batch" } }), true);
});
