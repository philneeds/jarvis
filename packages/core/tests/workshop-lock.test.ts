import { test } from "node:test";
import assert from "node:assert/strict";
import { Workshop } from "../src/index.js";

test("the workshop takes one run at a time: a second claim is refused until the first releases, or goes stale", () => {
  let now = Date.parse("2026-11-07T20:24:00Z");
  const w = new Workshop({ dir: "/nowhere/workshop", appDir: "/nowhere/app", now: () => new Date(now) });
  w.claim("Phil shared Brian Armstrong's X post");
  assert.deepEqual(w.busy, { task: "Phil shared Brian Armstrong's X post", at: "2026-11-07T20:24:00.000Z" });
  now += 2 * 60_000;
  assert.throws(() => w.claim("Phil, Sat Nov 7, in full: yes send this"), /in use by another run of yours since 20:24 UTC \("Phil shared Brian Armstrong's X post"\); it frees up when that run ends/);
  w.release();
  assert.equal(w.busy, undefined);
  w.claim("second task");
  // A claim left behind by a run that died is not held forever.
  now += Workshop.LOCK_MS + 1;
  w.claim("third task");
  assert.equal(w.busy?.task, "third task");
});
