import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, ingestHealth, healthSummary, healthKey, healthKeyOk, rotateHealthKey, Jarvis } from "../src/index.js";

// Shaped like Health Auto Export's REST API JSON.
const payload = {
  data: {
    metrics: [
      { name: "step_count", units: "count", data: [{ date: "2026-11-04 08:00:00 -0500", qty: 4000 }, { date: "2026-11-04 18:00:00 -0500", qty: 5200 }, { date: "2026-11-05 09:00:00 -0500", qty: 1500 }] },
      { name: "resting_heart_rate", units: "count/min", data: [{ date: "2026-11-04 00:00:00 -0500", qty: 58 }, { date: "2026-11-04 12:00:00 -0500", qty: 62 }] },
      { name: "weight_body_mass", units: "lb", data: [{ date: "2026-11-04 07:00:00 -0500", qty: 181.2 }, { date: "2026-11-04 21:00:00 -0500", qty: 180.6 }] },
      { name: "sleep_analysis", units: "hr", data: [{ date: "2026-11-05 00:00:00 -0500", totalSleep: 7.3, deep: 1.1, rem: 1.6, core: 4.6, awake: 0.4, sleepStart: "2026-11-04 23:20:00 -0500", sleepEnd: "2026-11-05 06:55:00 -0500" }] },
      { name: "time_in_daylight", units: "min", data: [{ date: "2026-11-04 12:00:00 -0500", qty: 35 }] },
    ],
    workouts: [{ name: "Traditional Strength Training", start: "2026-11-04 17:30:00 -0500", end: "2026-11-04 18:20:00 -0500", duration: 3000, activeEnergyBurned: { qty: 310, units: "kcal" } }],
  },
};

test("Apple Health: a payload folds into days; a resend doesn't double; Doc reads it plainly", async () => {
  const store = memoryStore(); await store.init();
  const now = new Date("2026-11-05T12:00:00Z");
  const r = await ingestHealth(store, payload, now);
  assert.equal(r.workouts, 1);
  assert.deepEqual(r.days, ["2026-11-04", "2026-11-05"]);
  await ingestHealth(store, payload, now); // the app resends the same window
  const s = await healthSummary(store, 7, now);
  assert.match(s, /2026-11-05: sleep 7\.3 h \(deep 1\.1, REM 1\.6\) · steps 1,500/);
  assert.match(s, /2026-11-04: steps 9,200 · resting HR 60 · weight 180\.6 lb · time in daylight 35 · workouts: Traditional Strength Training 50 min 310 kcal/);
  assert.match(s, /last sync under an hour ago/);
  await assert.rejects(ingestHealth(store, { nope: 1 }, now), /not a Health Auto Export payload/);
  // The tool is on every agent's list; Doc's charter gives it to him by default.
  const j = new Jarvis({ store });
  assert.ok(j.allTools().some((t) => t.name === "health_summary"));
});

test("Apple Health key: made in Settings, checked in constant time, rotated", async () => {
  const store = memoryStore(); await store.init();
  assert.equal(await healthKeyOk(store, "anything"), false, "no key yet: nothing gets in");
  const k = (await healthKey(store, true))!;
  assert.ok(k.length >= 30);
  assert.equal(await healthKeyOk(store, k), true);
  assert.equal(await healthKeyOk(store, k + "x"), false);
  const k2 = await rotateHealthKey(store);
  assert.equal(await healthKeyOk(store, k), false, "the old key stops working");
  assert.equal(await healthKeyOk(store, k2), true);
});
