import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, isReversible, bus, type JarvisEvent, type Approval } from "../src/index.js";

function make() {
  const store = memoryStore();
  const router = new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } });
  return { store, jarvis: new Jarvis({ store, router }) };
}
const card = (action: string, extra: Record<string, unknown> = {}, kind: Approval["kind"] = "record") => ({ kind, payload: { action, ...extra } });

test("which work counts as reversible", () => {
  for (const a of ["memory.replace", "goals.update", "goals.benchmarks", "today.set", "gmail.archive", "gmail.label"]) assert.equal(isReversible(card(a)), true, a);
  for (const a of ["watchlist.add", "gmail.send", "gmail.trash", "calendar.create", "calendar.delete", "ghl.note", "ghl.deal.move", "goals.set", "trade.execute", "code.ship", "hq.update", "x.post"]) assert.equal(isReversible(card(a)), false, a);
  assert.equal(isReversible(card("memory.replace", {}, "money")), false, "a money card never runs alone, whatever its action");
  assert.equal(isReversible(card("gmail.label", { public: true })), false);
  assert.equal(isReversible({ kind: "record", payload: {} }), false, "no action, nothing to run");
});

test("Oscar's memory tidy runs on its own, shows under Done for you, and Undo puts memory back", async () => {
  const { jarvis, store } = make();
  for (let i = 0; i < 8; i++) await store.memory.set({ scope: "phil", key: `k${i}`, value: `v${i}`, source: "phil" });
  const seen: JarvisEvent[] = [];
  const on = (e: JarvisEvent) => seen.push(e);
  bus.on("event", on);
  try {
    // Oscar's charter says every action waits; reversible work goes through anyway.
    const a = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "Oscar: condense memory 8 → 5", body: "merged", payload: { action: "memory.replace", keep: [0, 1, 2, 3, 4].map((i) => ({ scope: "phil", key: `k${i}`, value: `v${i}` })) } });
    assert.equal(a.status, "approved");
    assert.equal((await store.approvals.list("pending")).length, 0, "nothing waiting on Phil");
    assert.equal((await store.memory.list()).length, 5);
    assert.ok(seen.some((e) => e.type === "autodone"));
    const [done] = await jarvis.autoDone();
    assert.equal(done!.agentId, "oscar");
    assert.equal((done as { snapshot?: unknown }).snapshot, undefined, "snapshots stay on the server");
    const r = await jarvis.undoAuto(done!.id);
    assert.equal(r.ok, true, r.result);
    assert.equal((await store.memory.list()).length, 8);
    assert.deepEqual(await jarvis.undoAuto(done!.id), { ok: false, result: "already undone" });
    assert.equal((await jarvis.autoDone())[0]!.undone?.result, "Memory is back to the 8 items it had before.");
  } finally { bus.off("event", on); }
});

test("a reversible change that's too big still waits, with the reason on the card", async () => {
  const { jarvis, store } = make();
  for (let i = 0; i < 10; i++) await store.memory.set({ scope: "phil", key: `k${i}`, value: `v${i}`, source: "phil" });
  const a = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "Oscar: condense memory 10 → 3", body: "", payload: { action: "memory.replace", keep: [0, 1, 2].map((i) => ({ scope: "phil", key: `k${i}`, value: `v${i}` })) } });
  assert.equal(a.status, "pending");
  assert.match((await store.approvals.get(a.id))!.note ?? "", /drops more than half of memory \(10 → 3\)/);
  assert.equal((await store.memory.list()).length, 10, "nothing changed");
  // Gmail over 200 messages waits too.
  const g = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "Archive old promos", body: "", payload: { action: "gmail.archive", query: "category:promotions", max: 1500 } });
  assert.equal(g.status, "pending");
});

test("Phil's switch turns it off; outbound work waits whatever the switch says", async () => {
  const { jarvis, store } = make();
  await store.settings.set(Jarvis.REVERSIBLE_KEY, false);
  const a = await jarvis.requestApproval({ agentId: "david", kind: "record", title: "Today's three", body: "", payload: { action: "today.set", items: [{ text: "One" }] } });
  // David's own charter lets internal work through, so this one still runs: the switch only stops the new rule.
  assert.equal(a.status, "approved");
  assert.equal((await jarvis.autoDone()).length, 0, "but it isn't logged as reversible work");
  const o = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "Oscar tidy", body: "", payload: { action: "memory.replace", keep: [{ scope: "phil", key: "a", value: "b" }] } });
  assert.equal(o.status, "pending", "with the switch off, Oscar waits as before");
  await store.settings.set(Jarvis.REVERSIBLE_KEY, true);
  const s = await jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Tracy", body: "Hi", payload: { action: "gmail.send", to: "t@example.com", subject: "Quote", body: "Hi" } });
  assert.equal(s.status, "pending");
});

test("goals and today's three come back as they were; only the newest change of a kind can be undone", async () => {
  const { jarvis } = make();
  const g = await jarvis.addGoal({ name: "Send 40 quotes", venture: "jdpm" });
  const marks = (await jarvis.updateGoal(g.id, { benchmarks: [{ text: "10 quotes" }, { text: "25 quotes" }] }))!.benchmarks!;
  await jarvis.requestApproval({ agentId: "david", kind: "record", title: "10 quotes met", body: "evidence", payload: { action: "goals.update", id: g.id, done: [marks[0]!.id] } });
  assert.equal((await jarvis.goals())[0]!.pct, 50);
  assert.equal((await jarvis.trophies()).length, 1);
  await jarvis.requestApproval({ agentId: "david", kind: "record", title: "25 quotes met", body: "evidence", payload: { action: "goals.update", id: g.id, done: [marks[1]!.id] } });
  const [newest, older] = await jarvis.autoDone();
  assert.match((await jarvis.undoAuto(older!.id)).result, /undo that one first/);
  assert.equal((await jarvis.undoAuto(newest!.id)).ok, true);
  assert.equal((await jarvis.goals())[0]!.pct, 50);
  assert.equal((await jarvis.undoAuto(older!.id)).ok, true);
  assert.equal((await jarvis.goals())[0]!.pct, 0);
  assert.equal((await jarvis.trophies()).length, 0, "trophies go back with the goals");
  const before = (await jarvis.today()).today.items.map((x) => x.text);
  await jarvis.requestApproval({ agentId: "david", kind: "record", title: "Today's three", body: "", payload: { action: "today.set", items: [{ text: "Call Tracy" }] } });
  assert.deepEqual((await jarvis.today()).today.items.map((x) => x.text), ["Call Tracy"]);
  assert.equal((await jarvis.undoAuto((await jarvis.autoDone())[0]!.id)).ok, true);
  assert.deepEqual((await jarvis.today()).today.items.map((x) => x.text), before);
});

test("Gmail archive and label record the messages they touched, and Undo puts them back through the connector", async () => {
  const { jarvis } = make();
  const calls: { op: string; ids?: string[] }[] = [];
  jarvis.addConnector({
    tools: () => [],
    executors: () => ({ "gmail.archive": async (a) => { const p = a.payload as { query?: string; doneIds?: string[] }; p.doneIds = ["m1", "m2"]; calls.push({ op: "archive", ids: p.doneIds }); return "Archived 2 message(s)."; } }),
    undoers: () => ({ "gmail.archive": async (a) => { calls.push({ op: "unarchive", ids: (a.payload as { doneIds?: string[] }).doneIds }); return "Moved back to the inbox: 2 message(s)."; } }),
  });
  const a = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "Archive receipts", body: "", payload: { action: "gmail.archive", query: "from:receipts", max: 50 } });
  assert.equal(a.status, "approved");
  const [done] = await jarvis.autoDone();
  assert.equal(done!.outcome, "Archived 2 message(s).");
  const r = await jarvis.undoAuto(done!.id);
  assert.equal(r.result, "Moved back to the inbox: 2 message(s).");
  assert.deepEqual(calls, [{ op: "archive", ids: ["m1", "m2"] }, { op: "unarchive", ids: ["m1", "m2"] }]);
});

test("Undo never throws away what happened after: newer memory stays, and goals changed since are left alone", async () => {
  const { jarvis, store } = make();
  for (let i = 0; i < 6; i++) await store.memory.set({ scope: "phil", key: `k${i}`, value: `v${i}`, source: "phil" });
  await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "tidy", body: "", payload: { action: "memory.replace", keep: [0, 1, 2, 3].map((i) => ({ scope: "phil", key: `k${i}`, value: `v${i}` })) } });
  await new Promise((r) => setTimeout(r, 5));
  await store.memory.set({ scope: "venture:jdpm", key: "new-fact", value: "Tracy prefers texts", source: "stella" });
  const r = await jarvis.undoAuto((await jarvis.autoDone())[0]!.id);
  assert.match(r.result, /plus 1 remembered since/);
  const keys = (await store.memory.list()).map((m) => m.key).sort();
  assert.deepEqual(keys, ["k0", "k1", "k2", "k3", "k4", "k5", "new-fact"]);
  // Goals: David ticks a benchmark, then Phil renames the goal; undoing David's tick would undo Phil's rename too.
  const g = await jarvis.addGoal({ name: "Send 40 quotes" });
  const b = (await jarvis.updateGoal(g.id, { benchmarks: [{ text: "10 quotes" }] }))!.benchmarks!;
  await jarvis.requestApproval({ agentId: "david", kind: "record", title: "10 met", body: "", payload: { action: "goals.update", id: g.id, done: [b[0]!.id] } });
  await jarvis.updateGoal(g.id, { name: "Send 40 roof quotes" });
  const u = await jarvis.undoAuto((await jarvis.autoDone())[0]!.id);
  assert.equal(u.ok, false);
  assert.match(u.result, /changed after this/);
  assert.equal((await jarvis.goals())[0]!.name, "Send 40 roof quotes");
});
