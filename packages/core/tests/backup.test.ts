import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { memoryStore, runBackup, backupStatus, SCHEDULES } from "../src/index.js";

test("backup: the JSON store is gzipped into the backup folder, old files are pruned, Drive gets a copy, and failures are recorded", async () => {
  const store = memoryStore(); await store.init();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-bk-"));
  const dataFile = path.join(dir, "jarvis.json");
  await fs.writeFile(dataFile, JSON.stringify({ settings: { goals: [{ name: "Launch v2" }] } }));
  // A stale file from 20 days ago, and a fresh one from yesterday.
  const old = path.join(dir, "jarvis-20261017-0315.json.gz"), fresh = path.join(dir, "jarvis-20261105-0315.json.gz");
  await fs.writeFile(old, "x"); await fs.utimes(old, new Date(Date.now() - 20 * 86_400_000), new Date(Date.now() - 20 * 86_400_000));
  await fs.writeFile(fresh, "x");
  const uploads: { name: string; bytes: number; mime: string }[] = [];
  let pruned = 0;
  const drive = { async upload(name: string, data: Buffer, mime: string) { uploads.push({ name, bytes: data.length, mime }); return "id1"; }, async prune(days: number) { pruned = days; return 1; } };
  const r = await runBackup(store, { dir, dataFile, databaseUrl: "", drive, now: () => new Date("2026-11-06T03:15:00Z") });
  assert.equal(r.ok, true, r.error);
  assert.match(r.file!, /jarvis-20261106-0315\.json\.gz$/);
  assert.equal(JSON.parse(gunzipSync(await fs.readFile(r.file!)).toString()).settings.goals[0].name, "Launch v2", "the dump restores");
  assert.equal(r.kept, 2, "today's and yesterday's stay");
  await assert.rejects(fs.stat(old), undefined, "the 20-day-old file is gone");
  assert.deepEqual(uploads.map((u) => [u.name, u.mime]), [["jarvis-20261106-0315.json.gz", "application/gzip"]]);
  assert.equal(pruned, 14);
  assert.equal(r.drive, "uploaded");
  assert.equal((await backupStatus(store))?.ok, true);
  // No database and no file: a recorded failure, not a crash.
  const bad = await runBackup(store, { dir, dataFile: path.join(dir, "missing.json"), databaseUrl: "" });
  assert.equal(bad.ok, false); assert.match(bad.error!, /no database and no data file/);
  assert.equal((await backupStatus(store))?.ok, false);
  // A Drive failure doesn't fail the backup.
  const r2 = await runBackup(store, { dir, dataFile, databaseUrl: "", drive: { async upload() { throw new Error("Google refused"); } }, now: () => new Date("2026-11-06T04:00:00Z") });
  assert.equal(r2.ok, true); assert.match(r2.drive!, /Drive copy failed: Google refused/);
  // pg_dump that fails is a failed backup.
  const r3 = await runBackup(store, { dir, databaseUrl: "postgres://nope", pgDump: "false", now: () => new Date("2026-11-06T05:00:00Z") });
  assert.equal(r3.ok, false); assert.match(r3.error!, /pg_dump exited|backup file is empty/);
  assert.ok(SCHEDULES.some((s) => s.id === "backup-nightly" && s.when === "daily@03:15"));
});
