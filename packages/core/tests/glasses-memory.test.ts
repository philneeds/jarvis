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

test("review, Nov 27: two weeks means two weeks with the memory switched off too, and Erase all isn't undone by a batch in flight", async () => {
  const { pruneHeard } = await import("../src/index.js");
  const was = process.env.HQ_PASSWORD; process.env.HQ_PASSWORD = "pw";
  try {
    const store = memoryStore(); await store.init();
    await setGlassesOptions(store, { listen: true });
    await saveHeard(store, [{ at: iso(30), text: "Mike said Friday" }], NOW);
    // Switched off: nothing is saved any more, so nothing would ever prune. HQ's timer does.
    await setGlassesOptions(store, { listen: false });
    assert.equal(await pruneHeard(store, NOW + 10 * 86_400_000), 0, "ten days on: still inside the two weeks");
    assert.equal(await pruneHeard(store, NOW + 15 * 86_400_000), 1);
    assert.deepEqual(await heardDays(store), []);
    assert.equal(await store.settings.get("glasses.heard.2026-11-25", null), null);
    // Reading does it too: recall never shows a day past the limit.
    await setGlassesOptions(store, { listen: true });
    await saveHeard(store, [{ at: iso(30), text: "old words" }], NOW);
    assert.match(await heardText(store, { query: "old", now: NOW + 20 * 86_400_000 }), /all-day memory is on, but they haven't sent anything|Nothing heard/);
    // A batch and an erase at the same moment: the erase wins whichever order they were asked in.
    await saveHeard(store, [{ at: iso(5), text: "first" }], NOW);
    const [, erased] = await Promise.all([saveHeard(store, [{ at: iso(1), text: "in flight" }], NOW), forgetHeard(store)]);
    assert.equal(erased, 1);
    assert.deepEqual(await heardDays(store), []);
    assert.equal(await store.settings.get("glasses.heard.2026-11-25", null), null);
  } finally { if (was === undefined) delete process.env.HQ_PASSWORD; else process.env.HQ_PASSWORD = was; }
});
