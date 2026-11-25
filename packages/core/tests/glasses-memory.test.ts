import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, saveHeard, heardText, heardDays, forgetHeard, glassesOptions, setGlassesOptions, glassesCard, GLASSES_TOOLS, CHARTERS, isSealedValue, type Approval } from "../src/index.js";

const NOW = Date.parse("2026-11-25T20:00:00Z"); // 3 pm Eastern
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

test("the switches are off until Phil turns them on, and only true or false is kept", async () => {
  const store = memoryStore(); await store.init();
  assert.deepEqual(await glassesOptions(store), { approvals: false, listen: false });
  assert.deepEqual(await setGlassesOptions(store, { listen: true }), { approvals: false, listen: true });
  assert.deepEqual(await setGlassesOptions(store, { approvals: "yes" as never }), { approvals: false, listen: true });
});

test("what the glasses heard is kept by day, sealed, searchable, two weeks at most, and erased on request", async () => {
  const was = process.env.HQ_PASSWORD; process.env.HQ_PASSWORD = "pw";
  try {
    const store = memoryStore(); await store.init();
    await setGlassesOptions(store, { listen: true });
    const r = await saveHeard(store, [{ at: iso(30), text: "  Mike said the roof   is done Friday " }, { at: iso(10), text: "Lunch with Dana at noon tomorrow" }, { at: iso(5), text: "x" }, { at: iso(20 * 24 * 60), text: "too old to keep" }], NOW);
    assert.equal(r.kept, 2, "a one-letter scrap and a line from three weeks ago aren't kept");
    assert.deepEqual(await heardDays(store), ["2026-11-25"]);
    assert.ok(isSealedValue(await store.settings.get("glasses.heard.2026-11-25", null)), "other people's words are sealed at rest");
    const today = await heardText(store, { now: NOW });
    assert.match(today, /^What the glasses heard on 2026-11-25 \(a transcript of everyone in earshot, not only Phil; it can mishear\):\n2:30 PM  Mike said the roof is done Friday\n2:50 PM  Lunch with Dana at noon tomorrow$/);
    assert.match(await heardText(store, { query: "roof", now: NOW }), /mentioning "roof".*\n2026-11-25 2:30 PM  Mike said the roof is done Friday$/);
    assert.match(await heardText(store, { query: "boat", now: NOW }), /Nothing heard in the last 1 day\(s\) mentions "boat"/);
    // Fifteen days on, the old day is dropped when the next lines come in.
    await saveHeard(store, [{ at: new Date(NOW + 15 * 86_400_000).toISOString(), text: "a new day" }], NOW + 15 * 86_400_000);
    assert.deepEqual(await heardDays(store), ["2026-12-10"]);
    assert.equal(await store.settings.get("glasses.heard.2026-11-25", null), null);
    assert.equal(await forgetHeard(store), 1);
    assert.deepEqual(await heardDays(store), []);
    assert.match(await heardText(store, { now: NOW }), /on, but they haven't sent anything/);
    await setGlassesOptions(store, { listen: false });
    assert.match(await heardText(store, { now: NOW }), /all-day memory is off/);
  } finally { if (was === undefined) delete process.env.HQ_PASSWORD; else process.env.HQ_PASSWORD = was; }
});

test("a card read on the glasses is plain words; what moves money says where to approve it; Lip has the recall tool", () => {
  const a = { id: "a1", at: "", agentId: "stella", kind: "record", status: "pending", title: "**Book** Myra", body: "Adds `Thursday 2pm`.\n\n- calendar", effect: "Creates the appointment" } as unknown as Approval;
  assert.deepEqual(glassesCard(a, "Stella", "p1", true), { id: "a1", print: "p1", who: "Stella", title: "Book Myra", text: "Adds Thursday 2pm. - calendar\nIf you approve: Creates the appointment", approvable: true });
  assert.match(glassesCard(a, "Stella", "p1", false).why!, /approve it in HQ or Telegram/);
  assert.ok(GLASSES_TOOLS.some((t) => t.name === "glasses_heard"));
  assert.ok(CHARTERS.lip!.tools!.includes("glasses_heard"));
});
