import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, Watchers, WATCH_STATE_KEY, inQuietHours, ghlInbound, fundingExtremes, type Watcher, type PerpRow } from "../src/index.js";

function make() {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  return { store, jarvis };
}
const at = (h: number, m: number) => { const d = new Date("2026-11-09T12:00:00Z"); d.setHours(h, m, 0, 0); return d; };

test("quiet hours: the window crosses midnight and is server-local", () => {
  assert.equal(inQuietHours(at(23, 0), "22:00-06:30"), true);
  assert.equal(inQuietHours(at(3, 0), "22:00-06:30"), true);
  assert.equal(inQuietHours(at(6, 29), "22:00-06:30"), true);
  assert.equal(inQuietHours(at(6, 30), "22:00-06:30"), false);
  assert.equal(inQuietHours(at(12, 0), "22:00-06:30"), false);
  assert.equal(inQuietHours(at(13, 0), "12:00-14:00"), true);
  assert.equal(inQuietHours(at(13, 0), "garbage"), false);
});

test("GoHighLevel inbound: the first look only sets the cursor; later looks return what customers wrote since", () => {
  const convs = [
    { id: "v1", lastMessageDirection: "inbound", lastMessageDate: 1_762_440_000 }, // seconds, Nov 6 14:40Z
    { id: "v2", lastMessageDirection: "outbound", lastMessageDate: 1_762_450_000_000 },
    { id: "v3", lastMessageDirection: "inbound", lastMessageDate: "2026-11-06T16:00:00Z" },
  ];
  const now = Date.parse("2026-11-06T15:00:00Z");
  const first = ghlInbound(convs, undefined, now);
  assert.deepEqual(first.fresh, []);
  assert.equal(first.cursor, Date.parse("2026-11-06T16:00:00Z"), "the newest inbound message, even if it is ahead of the clock");
  const later = ghlInbound(convs, Date.parse("2026-11-06T15:00:00Z"), now + 3_600_000);
  assert.deepEqual(later.fresh.map((c) => c.id), ["v3"], "only inbound and only after the cursor");
  assert.equal(later.cursor, Date.parse("2026-11-06T16:00:00Z"));
  const nothing = ghlInbound(convs, Date.parse("2026-11-06T16:00:00Z"), now + 7_200_000);
  assert.deepEqual(nothing.fresh, []);
});

test("funding extremes: only markets that newly crossed, with enough open interest, count as an event", () => {
  const row = (coin: string, fundingHr: number, change24h: number, oiUsd: number): PerpRow => ({ coin, fundingHr, fundingApr: fundingHr * 8760, oiUsd, price: 1, change24h, volume24h: 0 });
  const rows = [row("BTC", 0.001, 1, 5e9), row("DOGE", 0.02, 3, 50e6), row("PEPE", 0.05, 2, 1e6), row("SOL", 0.002, -12, 800e6)];
  const th = { fundingHr: 0.01, movePct: 10, oiMinUsd: 20e6 };
  const first = fundingExtremes(rows, undefined, th);
  assert.deepEqual(first.coins, [], "first look sets the baseline");
  assert.deepEqual(first.cursor, ["DOGE", "SOL"], "PEPE is too small to count");
  const same = fundingExtremes(rows, first.cursor, th);
  assert.deepEqual(same.coins, []);
  const next = fundingExtremes([...rows, row("ETH", -0.015, 2, 2e9)], first.cursor, th);
  assert.deepEqual(next.coins, ["ETH"]);
  assert.deepEqual(next.cursor, ["DOGE", "ETH", "SOL"]);
  // A market that cooled off and heats up again is news again.
  const cooled = fundingExtremes([row("BTC", 0.001, 1, 5e9)], next.cursor, th);
  assert.deepEqual(cooled.cursor, []);
  assert.deepEqual(fundingExtremes(rows, cooled.cursor, th).coins, ["DOGE", "SOL"]);
});

test("a watcher wakes its agent only on an event, respects its timer, phase and quiet hours, and the answer goes up the chain", async () => {
  const { store, jarvis } = make();
  await store.init();
  await store.settings.set("phase", 1);
  let event: string | undefined;
  let looks = 0;
  const w: Watcher = { id: "t-leads", agentId: "stella", every: 10, phase: 1, maxPerDay: 2, summary: "test", async check(cursor) { looks++; return { cursor: (Number(cursor) || 0) + 1, event }; } };
  const late: Watcher = { id: "t-later", agentId: "pentoshi", every: 10, phase: 2, maxPerDay: 2, summary: "test", async check(cursor) { return { cursor }; } };
  const ws = new Watchers(jarvis, {}, [w, late]);
  // Phase 2 watcher waits; quiet hours stop everything.
  assert.deepEqual(ws.due(at(9, 0), 1, {}).map((x) => x.id), ["t-leads"]);
  assert.deepEqual(ws.due(at(9, 0), 2, {}).map((x) => x.id), ["t-leads", "t-later"]);
  assert.deepEqual(ws.due(at(23, 30), 2, {}), []);
  // No event: the agent doesn't run, the cursor moves, the timer holds the next look.
  await ws.tick(at(9, 0));
  assert.equal(looks, 1);
  assert.deepEqual(ws.due(at(9, 5), 1, await store.settings.get(WATCH_STATE_KEY, {})), []);
  assert.deepEqual(ws.due(at(9, 10), 1, await store.settings.get(WATCH_STATE_KEY, {})).map((x) => x.id), ["t-leads"]);
  assert.equal((await store.activity.list({ agentId: "stella" })).filter((e) => e.kind === "run").length, 0);
  // An event: Stella runs, the log says why, and her answer is in Jarvis's inbox for the brief.
  event = "1 new customer message in GoHighLevel:\n[v1] Ana Lopez · they wrote: \"Any update on the quote?\"";
  await ws.tick(at(9, 10));
  const log = await store.activity.list({ agentId: "stella" });
  assert.ok(log.some((e) => e.kind === "schedule" && /Watcher t-leads: Stella woke on 1 new customer message/.test(e.summary)));
  const stellaRuns = async () => (await store.activity.list({ agentId: "stella" })).filter((e) => e.kind === "run" && /^Stella ran/.test(e.summary));
  const run = await store.runs.get((await stellaRuns())[0]!.runId!);
  assert.match(run!.prompt, /Watcher asks: 1 new customer message[\s\S]*HQ's t-leads watcher/);
  const inbox = await store.settings.get<{ scheduleId: string }[]>("reports.inbox", []);
  assert.equal(inbox[0]?.scheduleId, "watch:t-leads");
  // The daily cap: the third event of the day is parked in her memory instead of a run, and said once.
  await ws.tick(at(9, 20));
  await ws.tick(at(9, 30));
  await ws.tick(at(9, 40));
  assert.equal((await stellaRuns()).length, 2, "two wakes today, then held");
  const parked = (await store.memory.list("agent:stella")).find((m) => m.key === "watch:t-leads");
  assert.ok(parked && /you haven't acted on it yet \(2 wakes today already\)/.test(parked.value));
  const held = (await store.activity.list({ agentId: "stella" })).filter((e) => /has woken 2 times today/.test(e.summary));
  assert.equal(held.length, 1);
  // A new day resets the count.
  const tomorrow = new Date(at(9, 0).getTime() + 86_400_000);
  await ws.tick(tomorrow);
  assert.equal((await stellaRuns()).length, 3);
  const view = await ws.view(tomorrow);
  assert.equal(view.find((v) => v.id === "t-leads")?.firedToday, 1);
});

test("a source that is down is reported once, and a paused agent's event is parked, not lost", async () => {
  const { store, jarvis } = make();
  await store.init();
  await store.settings.set("phase", 1);
  let fail = true;
  const w: Watcher = { id: "t-src", agentId: "stella", every: 1, phase: 1, maxPerDay: 5, summary: "test", async check(cursor) { if (fail) throw new Error("GoHighLevel refused the key"); return { cursor, event: "something new" }; } };
  const ws = new Watchers(jarvis, {}, [w]);
  await ws.tick(at(9, 0)); await ws.tick(at(9, 1)); await ws.tick(at(9, 2));
  const errors = (await store.activity.list({ agentId: "stella" })).filter((e) => e.kind === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.summary, /Watcher t-src couldn't read its source: GoHighLevel refused the key/);
  fail = false;
  await jarvis.pause("@stella", true);
  await ws.tick(at(9, 3));
  const parked = (await store.memory.list("agent:stella")).find((m) => m.key === "watch:t-src");
  assert.ok(parked && /Stella is paused/.test(parked.value));
  assert.ok((await store.activity.list({ agentId: "stella" })).some((e) => /reading its source again/.test(e.summary)));
});
