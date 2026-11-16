import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, bus, type JarvisEvent } from "../src/index.js";

/** To-dos tick themselves when a card that went through finished them. The model here answers from a script. */
function make(answer: (prompt: string) => string | undefined) {
  const store = memoryStore();
  const provider = mockProvider("mock");
  const base = provider.run.bind(provider);
  const asked: string[] = [];
  provider.run = async (req) => {
    if (/^The card that went through/.test(req.prompt)) {
      asked.push(req.prompt);
      const text = answer(req.prompt);
      if (text === undefined) throw new Error("model not available");
      return { text, provider: "mock", modelId: "m", inputTokens: 10, outputTokens: 5, costUsd: 0, durationMs: 1 };
    }
    if (/^NEW card:/.test(req.prompt)) return { text: '{"same":[]}', provider: "mock", modelId: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 };
    return base(req);
  };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  let sent = 0;
  jarvis.addConnector({ tools: () => [], executors: () => ({ "note.send": async () => { sent++; return "Sent to Tracy."; }, "note.fail": async () => { throw new Error("mailbox is full"); } }) } as never);
  return { store, jarvis, asked, sent: () => sent };
}
const idOf = (prompt: string, title: string) => new RegExp(`^([0-9a-f]{8}) \\| ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").exec(prompt)?.[1];
const settled = () => new Promise((r) => setTimeout(r, 40)); // the check runs in the background after Approve returns
const todos = async (jarvis: Jarvis) => Object.fromEntries((await jarvis.attention(true)).map((i) => [i.title, i.status]));

test("approving a card ticks the to-do it finishes, says which card did it, and leaves the rest", async () => {
  const { jarvis, asked } = make((p) => JSON.stringify({ done: [{ id: idOf(p, "Approve Stella's quote email to Tracy"), why: "the email was sent" }] }));
  const mine = await jarvis.raiseAttention({ title: "Approve Stella's quote email to Tracy", why: "she's waiting on the roof quote", agentId: "stella" });
  await jarvis.raiseAttention({ title: "Call the roofing supplier", why: "prices changed", agentId: "bill" });
  const events: JarvisEvent[] = []; const on = (e: JarvisEvent) => events.push(e); bus.on("event", on);
  try {
    const card = await jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Tracy the roof quote", body: "Hi Tracy, the quote is attached.", payload: { action: "note.send" } });
    await jarvis.decide(card.id, "approved");
    await settled();
    assert.deepEqual(await todos(jarvis), { "Approve Stella's quote email to Tracy": "done", "Call the roofing supplier": "open" });
    const done = (await jarvis.attention(true)).find((i) => i.id === mine.id)!;
    assert.deepEqual(done.doneBy, { approvalId: card.id, title: "Email Tracy the roof quote", why: "the email was sent" });
    assert.match(asked[0]!, /What happened: Sent to Tracy\./);
    assert.ok(events.some((e) => e.type === "attention" && e.change === "done" && e.item.id === mine.id), "open screens update");
    const chat = await jarvis.store.chat.list(20);
    assert.ok(chat.some((m) => /Ticked off your to-do: "Approve Stella's quote email to Tracy"\. Done by "Email Tracy the roof quote"\. Reopen/.test(m.text)));
    // A to-do HQ ticked isn't XP for Phil; one he ticks himself is, and reopening clears the note.
    assert.equal((await jarvis.baseSummary()).player.from.todosDone, 0);
    const back = await jarvis.attentionUpdate(mine.id, "reopened");
    assert.equal(back?.doneBy, undefined);
    await jarvis.attentionUpdate(mine.id, "done");
    assert.equal((await jarvis.baseSummary()).player.from.todosDone, 1);
  } finally { bus.off("event", on); }
});

test("nothing is ticked when the card was rejected or failed, or the model is unsure, missing or wrong", async () => {
  // Rejected and failed cards never reach the check.
  const a = make(() => { throw new Error("should not be asked"); });
  await a.jarvis.raiseAttention({ title: "Approve the email to Tracy", why: "x", agentId: "stella" });
  const rejected = await a.jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Tracy", body: "v1", payload: { action: "note.send" } });
  await a.jarvis.decide(rejected.id, "rejected");
  const failing = await a.jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Tracy again", body: "v2", payload: { action: "note.fail" } });
  assert.match((await a.jarvis.decide(failing.id, "approved"))?.note ?? "", /Failed to execute/);
  await settled();
  assert.equal(a.asked.length, 0);
  assert.deepEqual(await todos(a.jarvis), { "Approve the email to Tracy": "open" });
  // The model says none, isn't there, answers in prose, or names an id that isn't on the list.
  for (const reply of ['{"done":[]}', undefined, "Probably the first one.", '{"done":[{"id":"deadbeef"}]}']) {
    const b = make(() => reply);
    await b.jarvis.raiseAttention({ title: "Call Tracy back", why: "she asked for a call", agentId: "stella" });
    const card = await b.jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Tracy the quote", body: "x", payload: { action: "note.send" } });
    await b.jarvis.decide(card.id, "approved");
    await settled();
    assert.deepEqual(await todos(b.jarvis), { "Call Tracy back": "open" }, String(reply));
  }
  // Turned off, nobody is asked.
  process.env.TODO_CHECK = "off";
  try {
    const c = make(() => { throw new Error("should not be asked"); });
    await c.jarvis.raiseAttention({ title: "Approve it", why: "x", agentId: "stella" });
    const card = await c.jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email", body: "x", payload: { action: "note.send" } });
    await c.jarvis.decide(card.id, "approved"); await settled();
    assert.equal(c.asked.length, 0);
  } finally { delete process.env.TODO_CHECK; }
});

test("a card that only records a decision is described as such, and HQ's own housekeeping never triggers the check", async () => {
  const { jarvis, asked } = make((p) => JSON.stringify({ done: [{ id: idOf(p, "Decide whether to fold Mindset Coach into Stevon") }] }));
  await jarvis.raiseAttention({ title: "Decide whether to fold Mindset Coach into Stevon", why: "Oscar asked", agentId: "oscar" });
  const card = await jarvis.requestApproval({ agentId: "oscar", kind: "config", title: "Fold Mindset Coach into Stevon", body: "the plan", payload: { action: "agents.fold" } });
  await jarvis.decide(card.id, "approved");
  await settled();
  assert.match(asked[0]!, /What happened: No connector handles "agents\.fold" yet; nothing was sent or changed/);
  assert.deepEqual(await todos(jarvis), { "Decide whether to fold Mindset Coach into Stevon": "done" });
  // Oscar's memory tidy and David's pick for today run all day; they can't finish a to-do and aren't checked.
  await jarvis.raiseAttention({ title: "Something else", why: "y", agentId: "oscar" });
  for (let i = 0; i < 8; i++) await jarvis.store.memory.set({ scope: "phil", key: `k${i}`, value: `v${i}`, source: "phil" });
  const before = asked.length;
  await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "tidy", body: "x", payload: { action: "memory.replace", keep: [0, 1, 2, 3, 4].map((i) => ({ scope: "phil", key: `k${i}`, value: `v${i}` })) } });
  await jarvis.requestApproval({ agentId: "david", kind: "record", title: "today", body: "x", payload: { action: "today.set", items: [{ text: "Call Tracy" }] } });
  await settled();
  assert.equal(asked.length, before);
});

test("a code change ticks its to-do when the deploy lands, not when it's approved", async () => {
  const { jarvis, asked, store } = make((p) => JSON.stringify({ done: [{ id: idOf(p, "Clear Einstein's workshop on the server"), why: "the workshop clears itself now" }] }));
  await jarvis.raiseAttention({ title: "Clear Einstein's workshop on the server", why: "git stash the two stuck files", agentId: "einstein" });
  const now = new Date().toISOString();
  await store.approvals.add({ id: "ship-1", at: now, agentId: "einstein", kind: "config", title: "Ship: the workshop clears leftovers itself", body: "the fix", payload: { action: "code.ship", sha: "abc1234" }, status: "approved", decidedAt: now });
  // Approving a ship card doesn't check: the code isn't live yet.
  jarvis.addConnector({ tools: () => [], executors: () => ({ "code.ship": async () => "Shipping abc1234; HQ is rebuilding." }) } as never);
  const pending = await jarvis.requestApproval({ agentId: "einstein", kind: "config", title: "Ship: something else", body: "x", payload: { action: "code.ship", sha: "def5678" } });
  await jarvis.decide(pending.id, "approved");
  await settled();
  assert.equal(asked.length, 0);
  // A deploy that rolled back finishes nothing; one that landed does.
  const deploy = (status: "done" | "rolled-back") => { (jarvis as unknown as { workshop: unknown }).workshop = { finish: async () => ({ record: { status, approvalId: "ship-1" }, message: status === "done" ? "Shipped: HQ is back up on the new code." : "Rolled back." }) }; };
  deploy("rolled-back"); await jarvis.finishShip(); await settled();
  assert.equal(asked.length, 0);
  assert.deepEqual(await todos(jarvis), { "Clear Einstein's workshop on the server": "open" });
  deploy("done"); await jarvis.finishShip(); await settled();
  assert.match(asked[0]!, /What happened: Shipped: HQ is back up on the new code\./);
  assert.deepEqual(await todos(jarvis), { "Clear Einstein's workshop on the server": "done" });
});
