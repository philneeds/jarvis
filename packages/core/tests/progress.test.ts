import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, bus, horizonOf, levelFor, ventureLevels, syncTrophies, pickToday, reconcileToday, streakOf, philDay, isOutbound, getAgent, SCHEDULES, type Goal, type JarvisEvent, type Trophy } from "../src/index.js";

function make() {
  const store = memoryStore();
  const router = new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } });
  return { store, jarvis: new Jarvis({ store, router }) };
}
const goal = (g: Partial<Goal>): Goal => ({ id: "g1", name: "Goal", pct: 0, primary: false, updatedAt: "2026-11-01T00:00:00Z", ...g });

test("a goal's horizon is what Phil set, else read off its deadline", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  assert.equal(horizonOf({}, now), "long");
  assert.equal(horizonOf({ deadline: "2026-11-20" }, now), "short");
  assert.equal(horizonOf({ deadline: "2027-01-31" }, now), "mid");
  assert.equal(horizonOf({ deadline: "2028-06-01" }, now), "long");
  assert.equal(horizonOf({ deadline: "2026-11-20", horizon: "long" }, now), "long", "an explicit horizon wins");
});

test("levels come from milestone points: 1, 3, 6 and 10 reach levels 2 to 5", () => {
  assert.deepEqual([0, 1, 2, 3, 5, 6, 9, 10, 40].map((n) => levelFor(n).level), [1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.equal(levelFor(2).next, 3);
  assert.equal(levelFor(10).next, undefined, "level 5 is the top");
  const t = (id: string, venture: string | undefined, kind: Trophy["kind"]): Trophy => ({ id, at: "", title: "", goalId: "g", goalName: "", venture, kind });
  const levels = ventureLevels([t("a", "jdpm", "benchmark"), t("b", "jdpm", "goal"), t("c", "crypto", "benchmark"), t("d", undefined, "goal")]);
  assert.deepEqual(levels.jdpm, { level: 2, hits: 2, next: 3 }, "a benchmark met and a goal finished are one trophy each");
  assert.equal(levels.crypto!.level, 2);
  assert.equal(Object.keys(levels).length, 2, "a trophy with no venture levels no building");
});

test("trophies follow the benchmarks: earned when met, taken back when unticked, kept when a met one is dropped", () => {
  const b = (id: string, done: boolean) => ({ id, text: `Benchmark ${id}`, weight: 1, done, doneAt: done ? "2026-11-10T00:00:00Z" : undefined });
  let r = syncTrophies([], goal({ venture: "jdpm", benchmarks: [b("a", true), b("b", false)], pct: 50 }));
  assert.deepEqual(r.trophies.map((t) => t.id), ["b:g1:a"]);
  assert.equal(r.trophies[0]!.venture, "jdpm");
  assert.equal(r.trophies[0]!.at, "2026-11-10T00:00:00Z", "dated when the benchmark was met");
  // Both met: the goal is finished, which is its own trophy.
  r = syncTrophies(r.trophies, goal({ venture: "jdpm", benchmarks: [b("a", true), b("b", true)], pct: 100 }));
  assert.deepEqual(r.trophies.map((t) => t.id), ["b:g1:a", "b:g1:b", "g:g1"]);
  // Unticking one takes back its trophy and the goal's.
  r = syncTrophies(r.trophies, goal({ venture: "jdpm", benchmarks: [b("a", true), b("b", false)], pct: 50 }));
  assert.deepEqual(r.trophies.map((t) => t.id), ["b:g1:a"]);
  // David rewrites the list without "a": it was met, so its trophy stays.
  r = syncTrophies(r.trophies, goal({ venture: "jdpm", benchmarks: [b("c", false)], pct: 0 }));
  assert.deepEqual(r.trophies.map((t) => t.id), ["b:g1:a"]);
  assert.equal(r.changed, false);
});

test("HQ's own pick for today: what's waiting on Phil first (two at most), then the next benchmark of each goal", () => {
  const approval = (id: string, at: string, agentId = "stella") => ({ id, at, agentId, kind: "send" as const, title: `Card ${id}`, body: "", status: "pending" as const });
  const todo = (id: string, at: string) => ({ id, at, title: `Todo ${id}`, why: "", agentId: "monica", status: "open" as const });
  const goals = [
    goal({ id: "later", name: "Later goal", deadline: "2027-06-01", benchmarks: [{ id: "x", text: "Later step", weight: 1, done: false }] }),
    goal({ id: "main", name: "Main goal", primary: true, venture: "jdpm", benchmarks: [{ id: "m1", text: "Done already", weight: 1, done: true }, { id: "m2", text: "Send 5 quotes", weight: 1, done: false }] }),
    goal({ id: "bare", name: "No benchmarks yet", deadline: "2026-12-01" }),
  ];
  const t = pickToday("2026-11-14", { pending: [approval("new", "2026-11-14T09:00:00Z"), approval("old", "2026-11-12T09:00:00Z")], attention: [todo("t", "2026-11-13T09:00:00Z")], goals });
  assert.deepEqual(t.items.map((x) => x.text), ["Decide: Card old", "Decide: Card new", "Send 5 quotes"], "oldest waiting first, then the primary goal's next benchmark");
  assert.equal(t.by, "auto");
  assert.deepEqual(t.items[2]!.ref, { kind: "benchmark", id: "m2", goalId: "main" });
  assert.equal(t.items[2]!.venture, "jdpm");
  assert.equal(t.items[0]!.venture, "jdpm", "an approval belongs to its agent's venture");
  // Nothing waiting: three goals, primary first, then nearest deadline. A goal with no benchmarks still gets a line.
  const g = pickToday("2026-11-14", { pending: [], attention: [], goals });
  assert.deepEqual(g.items.map((x) => x.text), ["Send 5 quotes", "Move \"No benchmarks yet\" forward", "Later step"]);
  assert.equal(pickToday("2026-11-14", { pending: [], attention: [], goals: [] }).items.length, 0, "nothing to pick from is an empty day, not invented work");
  // A long goal with nothing to tick but a shorter goal under it is reached through that goal: no line of its own.
  const fed = pickToday("2026-11-14", { pending: [], attention: [], goals: [goal({ id: "star", name: "North star", primary: true }), goal({ id: "q", name: "This quarter", parent: "star", benchmarks: [{ id: "b", text: "First step", weight: 1, done: false }] })] });
  assert.deepEqual(fed.items.map((x) => x.text), ["First step"]);
});

test("today's items tick themselves when the thing they point at is done", () => {
  const pending = [{ id: "a1", at: "", agentId: "stella", kind: "send" as const, title: "Card", body: "", status: "pending" as const }];
  const attention = [{ id: "t1", at: "", title: "Todo", why: "", agentId: "monica", status: "open" as const }];
  const goals = [goal({ id: "main", benchmarks: [{ id: "m", text: "Step", weight: 1, done: false }] })];
  const day = pickToday("2026-11-14", { pending, attention, goals });
  assert.equal(reconcileToday(day, { pending, attention, goals }).changed, false);
  const after = reconcileToday(day, { pending: [], attention: [{ ...attention[0]!, status: "snoozed" }], goals: [goal({ id: "main", pct: 100, benchmarks: [{ id: "m", text: "Step", weight: 1, done: true }] })] });
  assert.deepEqual(after.today.items.map((x) => x.done), [true, false, true], "decided and met are done; a snoozed to-do is not");
});

test("the streak counts full days in a row, and an unfinished today doesn't break it", () => {
  const log = { "2026-11-11": { done: 1, total: 3 }, "2026-11-12": { done: 3, total: 3 }, "2026-11-13": { done: 2, total: 2 }, "2026-11-14": { done: 1, total: 3 } };
  assert.equal(streakOf(log, "2026-11-14"), 2);
  assert.equal(streakOf({ ...log, "2026-11-14": { done: 3, total: 3 } }, "2026-11-14"), 3);
  assert.equal(streakOf({ "2026-11-13": { done: 0, total: 0 } }, "2026-11-14"), 0, "an empty day is not a full day");
});

test("goals carry a horizon, a venture and the goal they feed; benchmarks met become trophies and level the venture", async () => {
  const { jarvis } = make();
  const seen: JarvisEvent[] = [];
  const on = (e: JarvisEvent) => seen.push(e);
  bus.on("event", on);
  try {
    const star = await jarvis.addGoal({ name: "$1M a year in jobs", horizon: "long", venture: "jdpm" });
    const mid = await jarvis.addGoal({ name: "Send 40 quotes", venture: "jdpm", parent: star.id, deadline: "2026-12-31" });
    assert.equal(mid.parent, star.id);
    assert.equal(mid.horizon, undefined, "left to the deadline unless Phil says");
    await assert.rejects(jarvis.updateGoal(mid.id, { venture: "nowhere" }), /no such venture/);
    await assert.rejects(jarvis.updateGoal(mid.id, { venture: "root" }), /no such venture/);
    await assert.rejects(jarvis.updateGoal(mid.id, { parent: mid.id }), /feed another goal/);
    const withMarks = await jarvis.updateGoal(mid.id, { benchmarks: [{ text: "10 quotes" }, { text: "25 quotes" }, { text: "40 quotes" }] });
    assert.equal((await jarvis.trophies()).length, 0);
    await jarvis.updateGoal(mid.id, { benchmarksDone: { done: [withMarks!.benchmarks![0]!.id] } }, "david");
    let base = await jarvis.baseSummary();
    assert.deepEqual(base.trophies.map((t) => [t.title, t.venture, t.kind]), [["10 quotes", "jdpm", "benchmark"]]);
    assert.equal(base.levels.jdpm!.level, 2, "one benchmark met reaches level 2");
    assert.ok(seen.some((e) => e.type === "base"), "screens are told to fetch the summary again");
    // Unticking takes the trophy and the level back.
    await jarvis.updateGoal(mid.id, { benchmarksDone: { undone: ["10 quotes"] } });
    base = await jarvis.baseSummary();
    assert.equal(base.trophies.length, 0);
    assert.equal(base.levels.jdpm, undefined);
    // Deleting the long goal leaves the one that fed it standing on its own.
    await jarvis.deleteGoal(star.id);
    assert.equal((await jarvis.goals()).find((g) => g.id === mid.id)!.parent, undefined);
    await jarvis.updateGoal(mid.id, { horizon: "mid", venture: null });
    const g = (await jarvis.goals()).find((x) => x.id === mid.id)!;
    assert.equal(g.horizon, "mid");
    assert.equal(g.venture, undefined);
  } finally { bus.off("event", on); }
});

test("today's three: HQ picks, Phil ticks, David replaces, and the streak follows", async () => {
  const { jarvis, store } = make();
  const g = await jarvis.addGoal({ name: "Send 40 quotes", venture: "jdpm" });
  const marks = (await jarvis.updateGoal(g.id, { benchmarks: [{ text: "10 quotes" }, { text: "25 quotes" }] }))!.benchmarks!;
  let { today, streak } = await jarvis.today();
  assert.equal(today.date, philDay());
  assert.equal(today.by, "auto");
  assert.deepEqual(today.items.map((x) => x.text), ["10 quotes"]);
  assert.equal(streak, 0);
  // Meeting the benchmark ticks the item on the next read; the day is then full.
  await jarvis.updateGoal(g.id, { benchmarksDone: { done: [marks[0]!.id] } });
  ({ today, streak } = await jarvis.today());
  assert.equal(today.items[0]!.done, true);
  assert.equal(streak, 1);
  // David's pick replaces HQ's. It auto-runs for him: it is internal, never outbound.
  assert.equal(isOutbound({ kind: "record", payload: { action: "today.set", items: [] } }), false);
  await jarvis.requestApproval({ agentId: "david", kind: "record", title: "Today's three", body: "why", payload: { action: "today.set", items: [{ text: "Call Tracy back" }, { text: "25 quotes", goalId: g.id, benchmarkId: marks[1]!.id }, { text: "Third" }, { text: "A fourth is dropped" }] } });
  ({ today } = await jarvis.today());
  assert.equal(today.by, "david");
  assert.deepEqual(today.items.map((x) => x.text), ["Call Tracy back", "25 quotes", "Third"]);
  assert.deepEqual(today.items[1]!.ref, { kind: "benchmark", id: marks[1]!.id, goalId: g.id });
  assert.equal(today.items[1]!.venture, "jdpm", "the goal's venture comes along");
  assert.equal((await store.approvals.list("pending")).length, 0, "nothing was left waiting on Phil");
  // Phil ticks one by hand, and unticks it.
  const first = today.items[0]!.id;
  assert.equal((await jarvis.toggleToday(first))!.items[0]!.done, true);
  assert.equal((await jarvis.toggleToday(first))!.items[0]!.done, false);
  assert.equal(await jarvis.toggleToday("nope"), undefined);
  // Asking for a fresh pick goes back to HQ's rule.
  assert.equal((await jarvis.repickToday()).by, "auto");
});

test("David has a morning routine for today's three, and the tools to pick from", () => {
  const s = SCHEDULES.find((x) => x.id === "david-today")!;
  assert.equal(s.agentId, "david");
  assert.match(s.when, /^daily@06:/, "before the 7:00 brief");
  assert.match(s.task, /today\.set/);
  assert.ok(getAgent("david"));
});
