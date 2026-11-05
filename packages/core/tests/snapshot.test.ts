import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, getAgent, dayStart, memoryLine, describeMemoryKey, type ActivityEntry } from "../src/index.js";

function make() {
  const store = memoryStore();
  const router = new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } });
  return { store, jarvis: new Jarvis({ store, router }) };
}

const entry = (agentId: string, at: string, kind: ActivityEntry["kind"] = "run"): ActivityEntry => ({ id: `${agentId}-${at}-${kind}`, at, agentId, kind, summary: `${agentId} ${kind}` });

test("dayStart is midnight in New York, across the DST change", () => {
  // Thu 5 Nov 2026, 10:00 EST (UTC-5): the day began at 05:00Z.
  assert.equal(dayStart(new Date("2026-11-05T15:00:00Z"), "America/New_York").toISOString(), "2026-11-05T05:00:00.000Z");
  // 00:30Z on 6 Nov is still 19:30 on the 5th in New York.
  assert.equal(dayStart(new Date("2026-11-06T00:30:00Z"), "America/New_York").toISOString(), "2026-11-05T05:00:00.000Z");
  // Sun 1 Nov 2026: clocks fell back at 02:00, but that day's midnight was still EDT (UTC-4).
  assert.equal(dayStart(new Date("2026-11-01T15:00:00Z"), "America/New_York").toISOString(), "2026-11-01T04:00:00.000Z");
  // Spring forward, Sun 8 Mar 2026: midnight EST.
  assert.equal(dayStart(new Date("2026-03-08T18:00:00Z"), "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");
});

test("snapshot counts each agent's runs today (Phil's day), not yesterday's or other kinds", async () => {
  const { store, jarvis } = make();
  await store.init();
  const now = new Date("2026-11-05T15:00:00Z");           // 10:00 in New York; the day began at 05:00Z
  for (const e of [
    entry("stella", "2026-11-05T05:00:00.000Z"),          // exactly midnight: counts
    entry("stella", "2026-11-05T14:59:00.000Z"),
    entry("stella", "2026-11-05T04:59:59.000Z"),          // 23:59 yesterday in New York: doesn't
    entry("stella", "2026-11-05T09:00:00.000Z", "memory"), // not a run
    entry("lucas", "2026-11-05T12:00:00.000Z"),
  ]) await store.activity.add(e);
  const snap = await jarvis.snapshot(now);
  const runs = Object.fromEntries(snap.map((a) => [a.id, a.runsToday]));
  assert.equal(runs.stella, 2);
  assert.equal(runs.lucas, 1);
  assert.equal(runs.munger, 0, "agents with no runs report 0, not undefined");
  assert.deepEqual(await store.activity.countSince("run", dayStart(now)), { stella: 2, lucas: 1 });
});

test("real runs show up in runsToday", async () => {
  const { store, jarvis } = make();
  await store.init();
  await jarvis.runAgent(getAgent("stella")!, "status?", { direct: true });
  await jarvis.runAgent(getAgent("stella")!, "and now?", { direct: true });
  await jarvis.runAgent(getAgent("lucas")!, "status?", { direct: true });
  const snap = await jarvis.snapshot();
  assert.equal(snap.find((a) => a.id === "stella")!.runsToday, 2);
  assert.equal(snap.find((a) => a.id === "lucas")!.runsToday, 1);
});

test("memory lines read like English, not keys", () => {
  assert.equal(memoryLine("Einstein", "agent:einstein", "idea:grok-phone-calls", "einstein"), "Einstein saved an idea: Grok phone calls.");
  assert.equal(memoryLine("Lip", "phil", "music:favourite-artists", "lip"), "Lip saved a note about music to Phil's profile.");
  assert.equal(memoryLine("Phil", "agent:einstein", "idea:grok-phone-calls"), "Phil saved an idea for Einstein: Grok phone calls.");
  assert.equal(memoryLine("Stella", "contact:jane-doe", "lastCall", "stella"), "Stella saved a note on Jane Doe: Last call.");
  assert.equal(memoryLine("Munger", "venture:money", "plan:q1-budget", "munger"), "Munger saved a plan for Money & stocks: Q1 budget.");
  assert.deepEqual(describeMemoryKey("favourite_coffee"), { thing: "a note", title: "Favourite coffee" });
});
