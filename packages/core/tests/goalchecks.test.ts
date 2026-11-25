import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, parseCheck, describeCheck, evaluateCheck, TOOLS, SCHEDULES, type BenchmarkCheck, type KuberaDay } from "../src/index.js";
import { HOUSEKEEPING } from "../src/scheduler.js";

const day = (d: string, nw: number, items: Record<string, number> = {}): KuberaDay => ({ day: d, netWorth: nw, assets: nw + 50_000, debts: 50_000, items });
const now = new Date("2026-11-23T17:30:00Z"); // 12:30 pm Eastern, Nov 23
const fresh = { ok: true, at: "2026-11-23T17:04:38.683Z" };

test("a check is read from an agent's payload only in a shape HQ can run, and described in a few words", () => {
  assert.deepEqual(parseCheck({ kind: "kubera_networth", op: ">=", value: "100000", days: "30" }), { kind: "kubera_networth", op: ">=", value: 100000, days: 30 });
  assert.deepEqual(parseCheck({ kind: "kubera_item", name: " Robinhood ", op: "<=", value: 5000 }), { kind: "kubera_item", name: "Robinhood", op: "<=", value: 5000 });
  assert.deepEqual(parseCheck({ kind: "metric", venture: "money", key: "net_worth", op: ">=", value: 100000, days: 1 }), { kind: "metric", venture: "money", key: "net_worth", op: ">=", value: 100000 }, "a one-day window is just the latest reading");
  assert.equal(parseCheck({ kind: "metric", venture: "root", key: "x", op: ">=", value: 1 }), undefined, "Jarvis has no board");
  assert.equal(parseCheck({ kind: "robinhood", op: ">=", value: 1 }), undefined, "no source HQ can't read");
  assert.equal(parseCheck({ kind: "kubera_networth", op: ">", value: 1 }), undefined);
  assert.equal(parseCheck({ kind: "kubera_networth", op: ">=", value: "lots" }), undefined);
  assert.equal(describeCheck({ kind: "kubera_networth", op: ">=", value: 100000, days: 30 }), "Kubera net worth ≥ $100,000 for 30 days");
  assert.equal(describeCheck({ kind: "kubera_item", name: "Robinhood 1888", op: ">=", value: 90000 }), 'Kubera "Robinhood 1888" ≥ $90,000');
  assert.equal(describeCheck({ kind: "metric", venture: "jdpm", key: "revenue_month", op: ">=", value: 6000 }), "JD PM board revenue_month ≥ 6,000");
});

test("Kubera net worth: the latest reading decides, a stale or failed read proves nothing, and a 'held for N days' rule needs every day on record", async () => {
  const history = [day("2026-11-21", 42_990), day("2026-11-22", 46_281), day("2026-11-23", 57_683, { "Robinhood 1888": 96_728, "Kalshi - Cash": 611, "Robinhood - Margin loan": -57_440 })];
  const nw: BenchmarkCheck = { kind: "kubera_networth", op: ">=", value: 100_000 };
  let r = await evaluateCheck(nw, { now, kubera: { status: fresh, history } });
  assert.equal(r.met, false);
  assert.equal(r.source, "Kubera net worth");
  assert.match(r.figure!, /^\$57,683, read Nov 23, 12:04 PM ET$/);
  r = await evaluateCheck({ ...nw, value: 50_000 }, { now, kubera: { status: fresh, history } });
  assert.equal(r.met, true);
  // Yesterday's reading is too old to say anything about today.
  r = await evaluateCheck(nw, { now, kubera: { status: { ok: true, at: "2026-11-21T12:00:00Z" }, history } });
  assert.equal(r.met, undefined);
  assert.match(r.error!, /last good reading is from Nov 21.*too old/);
  r = await evaluateCheck(nw, { now, kubera: { status: { ok: false, at: "2026-11-23T17:00:00Z", error: "Kubera refused the key (401)" }, history } });
  assert.match(r.error!, /last read failed: Kubera refused the key/);
  r = await evaluateCheck(nw, { now });
  assert.match(r.error!, /isn't connected or hasn't been read/);
  // Held for 3 days: all three days must be on record and above the line.
  r = await evaluateCheck({ ...nw, value: 40_000, days: 3 }, { now, kubera: { status: fresh, history } });
  assert.equal(r.met, true);
  assert.match(r.figure!, /\$57,683 today; 3 of 3 days on record \(\$42,990 to \$57,683\)/);
  r = await evaluateCheck({ ...nw, value: 45_000, days: 3 }, { now, kubera: { status: fresh, history } });
  assert.equal(r.met, false, "Nov 21 was under the line");
  r = await evaluateCheck({ ...nw, value: 40_000, days: 30 }, { now, kubera: { status: fresh, history } });
  assert.equal(r.met, false, "only 3 of 30 days on record: not proven yet");
  assert.match(r.figure!, /3 of 30 days on record/);
  // One account, by name: Robinhood's figure in Kubera is gross of the margin loan, which is its own (negative) line.
  r = await evaluateCheck({ kind: "kubera_item", name: "robinhood 1888", op: ">=", value: 90_000 }, { now, kubera: { status: fresh, history } });
  assert.equal(r.met, true);
  assert.equal(r.source, "Kubera · Robinhood 1888");
  assert.match(r.figure!, /^\$96,728, read/);
  r = await evaluateCheck({ kind: "kubera_item", name: "margin", op: ">=", value: -60_000 }, { now, kubera: { status: fresh, history } });
  assert.equal(r.met, true, "a debt reads as a negative number");
  r = await evaluateCheck({ kind: "kubera_item", name: "Chase business", op: ">=", value: 1 }, { now, kubera: { status: fresh, history } });
  assert.match(r.error!, /no account called "Chase business" in Kubera/);
});

test("a board figure: the latest reading, stale after a week, or held for N days", async () => {
  const points = [
    { id: "1", venture: "money", key: "net_worth", at: "2026-11-21T12:00:00Z", value: 42_990, source: "munger" },
    { id: "2", venture: "money", key: "net_worth", at: "2026-11-22T12:00:00Z", value: 46_281, source: "munger" },
    { id: "3", venture: "money", key: "net_worth", at: "2026-11-23T14:53:00Z", value: 102_243, source: "munger" },
    { id: "4", venture: "money", key: "net_worth", at: "2026-11-23T17:06:31Z", value: 57_683, source: "buffett" },
  ];
  const metrics = async (v: string, k: string) => points.filter((p) => p.venture === v && p.key === k);
  const c: BenchmarkCheck = { kind: "metric", venture: "money", key: "net_worth", op: ">=", value: 100_000 };
  let r = await evaluateCheck(c, { now, metrics });
  assert.equal(r.met, false, "the latest reading of the day, not the withdrawn one earlier");
  assert.match(r.figure!, /^57,683, recorded Nov 23, 12:06 PM ET by buffett$/);
  r = await evaluateCheck({ ...c, value: 40_000, days: 3 }, { now, metrics });
  assert.equal(r.met, true);
  r = await evaluateCheck({ ...c, value: 45_000, days: 3 }, { now, metrics });
  assert.equal(r.met, false);
  r = await evaluateCheck({ ...c, key: "cash" }, { now, metrics });
  assert.match(r.error!, /nothing recorded on the MONEY board under cash yet/);
  r = await evaluateCheck(c, { now: new Date("2026-12-05T12:00:00Z"), metrics });
  assert.match(r.error!, /older than 7 days/);
  r = await evaluateCheck(c, { now });
  assert.match(r.error!, /can't be read here/);
});

test("HQ ticks a checked benchmark from Kubera, unticks it when the figure drops, and keeps out once Phil touches it by hand", async () => {
  const store = memoryStore(); await store.init();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("m")] } }) });
  let refreshed = 0;
  jarvis.goalDataRefresh = async () => { refreshed++; };
  const g = await jarvis.addGoal({ name: "Maintain $100k+ net worth", horizon: "mid", venture: "money" });
  await jarvis.updateGoal(g.id, { benchmarks: [{ text: "Net worth back above $100k (Kubera)", weight: 60, check: { kind: "kubera_networth", op: ">=", value: 100_000 } }, { text: "Margin paid down by $20k", weight: 40 }] });
  const goal = async () => (await jarvis.goals()).find((x) => x.id === g.id)!;
  const auto = async () => (await goal()).benchmarks!.find((b) => b.check)!;
  assert.equal((await auto()).check?.kind, "kubera_networth");
  assert.equal((await jarvis.syncGoalChecks()).summary, "goal checks: 1 benchmark read, 1 source couldn't be read", "no Kubera yet: nothing ticked, the row says why");
  assert.equal(refreshed, 1);
  assert.match((await auto()).auto!.error!, /isn't connected/);
  assert.equal((await auto()).done, false);

  await store.settings.set("kubera.status", { ok: true, at: new Date().toISOString() });
  await store.settings.set("kubera.history", [day("2026-11-22", 46_281), day(new Date().toISOString().slice(0, 10), 104_500)]);
  let r = await jarvis.syncGoalChecks();
  assert.equal(r.changed, true);
  assert.match(r.summary, /1 ticked/);
  let b = await auto();
  assert.equal(b.done, true);
  assert.equal(b.auto!.met, true);
  assert.match(b.auto!.figure!, /^\$104,500, read /);
  assert.equal((await goal()).pct, 60);
  assert.ok((await jarvis.baseSummary()).trophies.some((t) => t.title === "Net worth back above $100k (Kubera)" && t.venture === "money"), "a benchmark met by data is a trophy like any other");
  const log = (await store.activity.list({ limit: 50 })).find((e) => /Goal check on "Maintain \$100k\+ net worth": met Net worth back above/.test(e.summary));
  assert.ok(log, "the tick is logged with the figure");

  // Kubera goes down: the tick stays, the error shows.
  await store.settings.set("kubera.status", { ok: false, at: new Date().toISOString(), error: "Kubera's limit is reached" });
  r = await jarvis.syncGoalChecks();
  assert.equal(r.changed, false);
  b = await auto();
  assert.equal(b.done, true, "a failed read proves nothing either way");
  assert.match(b.auto!.error!, /limit is reached/);

  // The figure drops: unticked, trophy taken back.
  await store.settings.set("kubera.status", { ok: true, at: new Date().toISOString() });
  await store.settings.set("kubera.history", [day(new Date().toISOString().slice(0, 10), 57_683)]);
  r = await jarvis.syncGoalChecks();
  assert.match(r.summary, /1 unticked/);
  b = await auto();
  assert.equal(b.done, false);
  assert.equal((await goal()).pct, 0);
  assert.ok(!(await jarvis.baseSummary()).trophies.some((t) => t.title.startsWith("Net worth back above")));

  // Phil ticks it himself: his word stands, HQ pauses the check until he resumes it.
  await jarvis.updateGoal(g.id, { benchmarksDone: { done: [b.id] } });
  b = await auto();
  assert.equal(b.paused, true);
  assert.equal((await jarvis.syncGoalChecks()).summary, "no checked benchmarks");
  assert.equal((await auto()).done, true, "left alone while paused");
  // Resuming (saving the check again) reads it straight away and the data wins again.
  await jarvis.updateGoal(g.id, { benchmarkChecks: { [b.id]: b.check! } });
  assert.equal((await auto()).paused, undefined);
  await jarvis.syncGoalChecks();
  assert.equal((await auto()).done, false);
  // Clearing the check leaves a plain benchmark.
  await jarvis.updateGoal(g.id, { benchmarkChecks: { [b.id]: null } });
  b = (await goal()).benchmarks![0]!;
  assert.equal(b.check, undefined); assert.equal(b.auto, undefined);
  // David's view and the hourly routine.
  await jarvis.updateGoal(g.id, { benchmarkChecks: { [b.id]: { kind: "kubera_networth", op: ">=", value: 100_000, days: 30 } } }, "david");
  await jarvis.syncGoalChecks(g.id);
  const text = await TOOLS.find((t) => t.name === "goals_list")!.handler({}, { store, agentId: "david" });
  assert.match(text, /\[ \] \(\w+\) Net worth back above \$100k \(Kubera\) · weight 60 · HQ checks: Kubera net worth ≥ \$100,000 for 30 days · not met, \$57,683 today; 1 of 30 days on record/);
  assert.match(text, /"kind":"kubera_networth"/, "the shapes David can use are spelled out");
  assert.ok(SCHEDULES.some((s) => s.id === "goal-check" && s.when === "every:60"));
  assert.ok(HOUSEKEEPING.has("goal-check"));
});

test("David can hand a benchmark its check on the goals.benchmarks card; a check HQ can't run is dropped, not saved", async () => {
  const store = memoryStore(); await store.init();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("m")] } }) });
  await store.settings.set("kubera.status", { ok: true, at: new Date().toISOString() });
  await store.settings.set("kubera.history", [day(new Date().toISOString().slice(0, 10), 57_683, { "Robinhood 1888": 96_728 })]);
  const g = await jarvis.addGoal({ name: "Reliable steady $6k/month", horizon: "short" });
  const card = await jarvis.requestApproval({ agentId: "david", kind: "record", title: "Benchmarks", body: "x", payload: { action: "goals.benchmarks", id: g.id, benchmarks: [
    { text: "Robinhood MCP account above $90k", weight: 30, check: { kind: "kubera_item", name: "Robinhood 1888", op: ">=", value: 90000 } },
    { text: "Last 3 months' income written down", weight: 30 },
    { text: "Chase business account above $5k", weight: 40, check: { kind: "chase", op: ">=", value: 5000 } },
  ] } });
  assert.match(card.effect ?? "", /3 benchmarks.*1 of them HQ ticks itself from live data/);
  const done = await jarvis.decide(card.id, "approved");
  assert.match(done?.note ?? "", /3 benchmarks \(1 checked by HQ against live data\)/);
  await new Promise((r) => setTimeout(r, 50));
  const marks = (await jarvis.goals()).find((x) => x.id === g.id)!.benchmarks!;
  assert.equal(marks[0]!.check?.kind, "kubera_item");
  assert.equal(marks[0]!.done, true, "read right after the card");
  assert.equal(marks[1]!.check, undefined);
  assert.equal(marks[2]!.check, undefined, "a source HQ can't read isn't a check");
  // Replacing the list by text keeps the check and its last reading on the benchmark that stayed.
  await jarvis.updateGoal(g.id, { benchmarks: [{ text: "Robinhood MCP account above $90k", weight: 50 }, { text: "First calendar month at $6k+", weight: 50 }] }, "david");
  const kept = (await jarvis.goals()).find((x) => x.id === g.id)!.benchmarks![0]!;
  assert.equal(kept.check?.kind, "kubera_item");
  assert.equal(kept.auto?.met, true);
});
