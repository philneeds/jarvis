import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, bus, type JarvisEvent } from "../src/index.js";

function make() {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("g")] } }) });
  return { store, jarvis };
}

function capture() {
  const seen: JarvisEvent[] = [];
  const off = bus.onEvent((e) => seen.push(e));
  return { seen, off };
}

test("editAttention changes title, why and due in place and tells other screens", async () => {
  const { jarvis, store } = make();
  const item = await jarvis.raiseAttention({ title: "Call the bank", why: "Card blocked", due: "2026-11-07", agentId: "jarvis" });
  const { seen, off } = capture();
  const edited = await jarvis.editAttention(item.id, { title: "  Call the bank about the card ", why: "Card blocked since Monday", due: "2026-11-09" });
  off();
  assert.equal(edited!.title, "Call the bank about the card");
  assert.equal(edited!.why, "Card blocked since Monday");
  assert.equal(edited!.due, "2026-11-09");
  assert.equal(edited!.id, item.id);
  const stored = (await jarvis.attention())[0]!;
  assert.equal(stored.title, "Call the bank about the card");
  const ev = seen.find((e) => e.type === "attention");
  assert.ok(ev && ev.type === "attention" && ev.change === "edited" && ev.item.id === item.id);
  // Clearing the due date, leaving the rest alone.
  const cleared = await jarvis.editAttention(item.id, { due: null });
  assert.equal(cleared!.due, undefined);
  assert.equal(cleared!.why, "Card blocked since Monday");
  await assert.rejects(jarvis.editAttention(item.id, { title: "   " }), /title can't be empty/);
  assert.equal(await jarvis.editAttention("nope", { title: "x" }), undefined);
  assert.ok((await store.activity.list({ q: "edited" })).length > 0);
});

test("goals: set, rename, progress, choose primary, delete and undo; agents see them in memory", async () => {
  const { jarvis, store } = make();
  assert.deepEqual(await jarvis.goals(), []);
  const { seen, off } = capture();
  const a = await jarvis.addGoal({ name: "Ship JD PM v2", pct: 30, deadline: "2026-12-31" });
  assert.equal(a.primary, true); // the first goal is primary
  const b = await jarvis.addGoal({ name: "Run a half marathon", pct: 140 });
  assert.equal(b.pct, 100); // clamped
  assert.equal(b.primary, false);
  const c = await jarvis.addGoal({ name: "Read 20 books" });
  assert.ok(seen.some((e) => e.type === "goals"));
  off();

  await jarvis.updateGoal(b.id, { name: "Run a full marathon", pct: 15 });
  await jarvis.updateGoal(c.id, { primary: true });
  let goals = await jarvis.goals();
  assert.deepEqual(goals.map((g) => g.name), ["Read 20 books", "Ship JD PM v2", "Run a full marathon"]);
  assert.equal(goals.filter((g) => g.primary).length, 1);
  assert.equal(goals[2]!.pct, 15);
  await jarvis.updateGoal(a.id, { deadline: null });
  assert.equal((await jarvis.goals()).find((g) => g.id === a.id)!.deadline, undefined);
  await assert.rejects(jarvis.updateGoal(a.id, { name: " " }), /name can't be empty/);
  assert.equal(await jarvis.updateGoal("nope", { pct: 1 }), undefined);

  const mem = await store.memory.get("phil", "goals");
  assert.match(mem!.value, /^Primary: Read 20 books \(0% done\)\. Also: Ship JD PM v2/);

  // Deleting the primary hands it to the next goal; undo puts it back where it was, primary again.
  const del = await jarvis.deleteGoal(c.id);
  goals = await jarvis.goals();
  assert.equal(goals.length, 2);
  assert.equal(goals[0]!.name, "Ship JD PM v2");
  assert.equal(goals[0]!.primary, true);
  assert.deepEqual(await jarvis.undo(del!.undoId), { kind: "goal", label: "Read 20 books" });
  goals = await jarvis.goals();
  assert.deepEqual(goals.map((g) => [g.name, g.primary]), [["Read 20 books", true], ["Ship JD PM v2", false], ["Run a full marathon", false]]);
  assert.equal(await jarvis.undo(del!.undoId), undefined); // only once
  assert.equal(await jarvis.deleteGoal("nope"), undefined);

  for (const g of await jarvis.goals()) await jarvis.deleteGoal(g.id);
  assert.equal(await store.memory.get("phil", "goals"), undefined);
});

test("goals kept the old way (JSON in memory) carry over once with stable ids", async () => {
  const { jarvis, store } = make();
  await store.memory.set({ scope: "phil", key: "goals", value: JSON.stringify({ primary: { name: "Exit the agency", pct: 40, deadline: "2027-06-01" }, secondary: [{ name: "Get fit", pct: 20 }, { name: "", pct: 0 }] }) });
  const goals = await jarvis.goals();
  assert.deepEqual(goals.map((g) => [g.name, g.pct, g.primary, g.deadline]), [["Exit the agency", 40, true, "2027-06-01"], ["Get fit", 20, false, undefined]]);
  assert.deepEqual((await jarvis.goals()).map((g) => g.id), goals.map((g) => g.id));
  assert.ok(await jarvis.updateGoal(goals[1]!.id, { pct: 25 }));
  assert.match((await store.memory.get("phil", "goals"))!.value, /Get fit \(25% done\)/);
});

test("a wrong metric reading can be corrected or removed (and the removal undone)", async () => {
  const { jarvis } = make();
  await jarvis.recordMetric("money", "net_worth", 125000, "phil", "2026-11-01T09:00:00Z");
  const wrong = await jarvis.recordMetric("money", "net_worth", 1275000, "munger", "2026-11-02T09:00:00Z");
  let m = (await jarvis.ventureDashboard("money")).metrics.find((x) => x.key === "net_worth")!;
  assert.equal(m.latestId, wrong.id);

  const fixed = await jarvis.editMetric("money", wrong.id, 127500);
  assert.equal(fixed!.value, 127500);
  m = (await jarvis.ventureDashboard("money")).metrics.find((x) => x.key === "net_worth")!;
  assert.equal(m.latest, 127500);
  assert.equal(m.delta, 2500);
  assert.equal(await jarvis.editMetric("crypto", wrong.id, 1), undefined); // another venture's reading
  assert.equal(await jarvis.editMetric("money", "nope", 1), undefined);
  await assert.rejects(jarvis.editMetric("money", wrong.id, Number.NaN), /must be a number/);

  const del = await jarvis.deleteMetric("money", wrong.id);
  assert.equal(del!.point.value, 127500);
  m = (await jarvis.ventureDashboard("money")).metrics.find((x) => x.key === "net_worth")!;
  assert.equal(m.latest, 125000);
  assert.equal(m.series.length, 1);
  assert.equal(await jarvis.deleteMetric("money", wrong.id), undefined);
  await jarvis.undo(del!.undoId);
  m = (await jarvis.ventureDashboard("money")).metrics.find((x) => x.key === "net_worth")!;
  assert.equal(m.latest, 127500);
  assert.equal(m.latestId, wrong.id);
});

test("forgetting memory and removing a venture record can be undone exactly", async () => {
  const { jarvis, store } = make();
  await store.memory.set({ scope: "contact:Smith", key: "phone", value: "555-0101", source: "stella" });
  const f = await jarvis.forgetMemory("contact:Smith", "phone");
  assert.equal(f!.item.value, "555-0101");
  assert.equal(await store.memory.get("contact:Smith", "phone"), undefined);
  assert.equal(await jarvis.forgetMemory("contact:Smith", "phone"), undefined);
  assert.deepEqual(await jarvis.undo(f!.undoId), { kind: "memory", label: "[contact:Smith] phone" });
  const back = await store.memory.get("contact:Smith", "phone");
  assert.equal(back!.value, "555-0101");
  assert.equal(back!.source, "stella");

  const rec = await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "Dana Smith", status: "quoted", fields: { value: 4200 }, source: "karol" });
  assert.equal(await jarvis.removeRecord("money", rec.id), undefined); // wrong venture
  const r = await jarvis.removeRecord("jdpm", rec.id);
  assert.equal(r!.record.title, "Dana Smith");
  assert.equal((await store.records.list("jdpm")).length, 0);
  await jarvis.undo(r!.undoId);
  const again = await store.records.get(rec.id);
  assert.deepEqual(again, rec);

  assert.equal(await jarvis.undo("nope"), undefined);
});

test("undo expires", async () => {
  const { jarvis, store } = make();
  await store.memory.set({ scope: "phil", key: "coffee", value: "black" });
  const f = await jarvis.forgetMemory("phil", "coffee");
  const was = Jarvis.UNDO_MS;
  Jarvis.UNDO_MS = 0;
  try { assert.equal(await jarvis.undo(f!.undoId), undefined); } finally { Jarvis.UNDO_MS = was; }
  assert.equal(await store.memory.get("phil", "coffee"), undefined);
});
