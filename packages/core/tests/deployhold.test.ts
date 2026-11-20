import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Jarvis, ModelRouter, Scheduler, Watchers, Workshop, memoryStore, mockProvider, getAgent, runRoutine, deployPending, DEPLOY_HOLD_MS, DEFERRED_KEY, HELD_JOBS_KEY, SHIP_KEY, WATCH_STATE_KEY, type HeldJob, type Schedule, type Store, type Watcher } from "../src/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const until = async (ok: () => Promise<boolean> | boolean, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
const exists = (f: string) => fs.stat(f).then(() => true).catch(() => false);

/** A bare "GitHub" and a live checkout of it. */
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hq-deployhold-"));
  const app = path.join(root, "app");
  git(root, "init", "-q", "--bare", "-b", "deploy", "origin.git");
  git(root, "clone", "-q", path.join(root, "origin.git"), "app");
  git(app, "config", "user.email", "t@t"); git(app, "config", "user.name", "t");
  await fs.writeFile(path.join(app, "README.md"), "hq\n");
  git(app, "add", "-A"); git(app, "commit", "-q", "-m", "init"); git(app, "push", "-q", "-u", "origin", "HEAD:deploy"); git(app, "checkout", "-q", "deploy");
  return { root, app };
}
/** A commit on "GitHub" that the live checkout isn't running yet, as a Claude Code session would push it. */
async function pushNewer(root: string) {
  git(root, "clone", "-q", path.join(root, "origin.git"), "session");
  const s = path.join(root, "session");
  git(s, "config", "user.email", "c@c"); git(s, "config", "user.name", "c");
  await fs.writeFile(path.join(s, "README.md"), "hq\nnewer\n");
  git(s, "add", "-A"); git(s, "commit", "-q", "-m", "a newer change"); git(s, "push", "-q", "origin", "HEAD:deploy");
  return git(s, "rev-parse", "HEAD");
}

/** A provider that records what it was asked and can keep chosen runs going until they are let go. */
function probe() {
  const seen: string[] = [];
  const gates = new Map<RegExp, { started: () => void; done: Promise<void> }>();
  const base = mockProvider("mock-claude");
  const provider = { ...base, async run(req: Parameters<typeof base.run>[0]) {
    seen.push(req.prompt);
    for (const [re, g] of gates) if (re.test(req.prompt)) { g.started(); await g.done; }
    return base.run(req);
  } };
  /** Runs matching `re` stay in progress until finish() is called; running resolves when one has started. */
  const keepGoing = (re: RegExp) => {
    let finish!: () => void, started!: () => void;
    const done = new Promise<void>((r) => { finish = r; });
    const running = new Promise<void>((r) => { started = r; });
    gates.set(re, { started, done });
    return { finish, running };
  };
  return { seen, provider, keepGoing };
}
function make(store: Store = memoryStore()) {
  const p = probe();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [p.provider], grok: [mockProvider("mock-grok")] } }) });
  return { store, jarvis, ...p };
}
const approved = (at: Date | number = Date.now(), title = "Update HQ: 2 new changes") => ({ at: new Date(at).toISOString(), sha: "abc1234abc1234", title, status: "shipping", kind: "update" });
const settled = { at: new Date().toISOString(), sha: "abc1234abc1234", title: "Update HQ: 2 new changes", status: "done", kind: "update" };

test("an update is pending only while its record says shipping, and not for ever", async () => {
  const store = memoryStore(); await store.init();
  assert.equal(await deployPending(store), undefined, "no deploy at all");
  await store.settings.set(SHIP_KEY, approved());
  assert.equal((await deployPending(store))?.status, "shipping");
  await store.settings.set(SHIP_KEY, settled);
  assert.equal(await deployPending(store), undefined, "HQ is back and has read the verdict");
  // A deploy that never restarted HQ must not stop the routines for good.
  await store.settings.set(SHIP_KEY, approved(Date.now() - DEPLOY_HOLD_MS - 60_000));
  assert.equal(await deployPending(store), undefined, "long past the 65-minute cap and the restart");
  await store.settings.set(SHIP_KEY, approved(Date.now() - 64 * 60_000));
  assert.ok(await deployPending(store), "inside the cap it still holds");
});

test("a routine due while an update is pending doesn't start, isn't marked as run, and runs right after the update", async () => {
  const { store, jarvis, seen } = make();
  await store.init();
  await store.settings.set("phase", 1);
  const daily: Schedule = { id: "t-daily", agentId: "stella", task: "Morning leads review", when: "daily@06:50", phase: 1 };
  const often: Schedule = { id: "t-often", agentId: "karol", task: "New lead check", when: "every:30", phase: 1 };
  const s = new Scheduler(jarvis, [daily, often]);
  const at = (h: number, m: number) => new Date(2026, 10, 20, h, m);
  await store.settings.set(SHIP_KEY, approved(at(6, 45)));
  await s.tick(at(6, 51));
  await s.tick(at(6, 52));
  assert.deepEqual(seen, [], "nothing started while the update waits");
  assert.deepEqual(await store.settings.get(DEFERRED_KEY, []), ["t-daily", "t-often"], "both are noted as due");
  assert.deepEqual(await store.settings.get("schedule.lastRun", {}), {}, "neither is marked as run");
  const noted = (await store.activity.list({ limit: 50 })).filter((e) => /waiting for the HQ update to go in/.test(e.summary));
  assert.equal(noted.length, 1, "said once, not on every tick");
  // What Phil asks for himself still runs.
  const asked = await runRoutine(jarvis, daily, { direct: true });
  assert.ok(asked && !asked.blocked);
  assert.equal(seen.filter((p) => /^Scheduler asks: Morning leads review/.test(p)).length, 1, "Phil's own ask ran during the wait");
  // HQ restarted on the new code: a fresh scheduler, the ship settled. 07:20 is past the daily routine's ten-minute window.
  await store.settings.set(SHIP_KEY, settled);
  const s2 = new Scheduler(jarvis, [daily, often]);
  await s2.tick(at(7, 20));
  assert.equal(seen.filter((p) => /^Scheduler asks: Morning leads review/.test(p)).length, 2, "the daily routine ran after the update");
  assert.equal(seen.filter((p) => /^Scheduler asks: New lead check/.test(p)).length, 1, "and so did the every-30-minutes one");
  assert.ok(seen.some((p) => /Karol reports to you \(t-often\)/.test(p)), "and its report went up to the lead as usual");
  assert.deepEqual(await store.settings.get(DEFERRED_KEY, ["x"]), []);
  await s2.tick(at(7, 21));
  assert.equal(seen.filter((p) => /^Scheduler asks: Morning leads review/.test(p)).length, 2, "once, not again on the next tick");
});

test("a watcher doesn't look or wake its agent while an update is pending, and catches up after it", async () => {
  const { store, jarvis, seen } = make();
  await store.init();
  await store.settings.set("phase", 1);
  let looks = 0;
  const w: Watcher = { id: "t-leads", agentId: "stella", every: 10, phase: 1, maxPerDay: 5, summary: "test", async check(cursor) { looks++; return { cursor: (Number(cursor) || 0) + 1, event: "1 new customer message in GoHighLevel" }; } };
  const ws = new Watchers(jarvis, {}, [w]);
  const day = (h: number, m: number) => new Date(Date.UTC(2026, 10, 20, h + 5, m)); // New York time, outside quiet hours
  await store.settings.set(SHIP_KEY, approved(day(9, 0)));
  await ws.tick(day(9, 5));
  assert.equal(looks, 0, "no look at the source");
  assert.deepEqual(seen, []);
  assert.deepEqual(await store.settings.get(WATCH_STATE_KEY, {}), {}, "the watcher is left due");
  await store.settings.set(SHIP_KEY, settled);
  await ws.tick(day(9, 20));
  assert.equal(looks, 1);
  assert.equal(seen.filter((p) => /new customer message/.test(p)).length, 1, "Stella woke once the update was in");
});

test("a workshop job asked for while an update is pending is held and saved, and starts after the restart", async () => {
  const { root, app } = await repo();
  const { store, jarvis, seen } = make();
  await store.init();
  jarvis.useWorkshop(new Workshop({ dir: path.join(root, "workshop"), appDir: app, verify: async () => ({ ok: true, report: "" }), pollMs: 20 }));
  const einstein = getAgent("einstein")!;
  await store.settings.set(SHIP_KEY, approved());
  const r = await jarvis.runAgent(einstein, "Add a dark mode to the Agent Web", { direct: true, from: "Phil" });
  assert.match(r.blocked ?? "", /held until the HQ update is in/);
  assert.deepEqual(seen, [], "the job didn't start");
  assert.notEqual((await store.agentState.get("einstein"))?.status, "working", "so the update isn't waiting for it");
  const jobs = await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, []);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.agentId, "einstein"); assert.equal(jobs[0]!.task, "Add a dark mode to the Agent Web"); assert.equal(jobs[0]!.from, "Phil"); assert.equal(jobs[0]!.why, "update");
  assert.ok(Date.now() - Date.parse(jobs[0]!.at) < 5000, "with when it was asked");
  const line = (await store.chat.list(50)).find((m) => /held, not started/.test(m.text));
  assert.ok(line && line.agentId === "einstein", "Phil is told in chat");
  assert.match(line.text, /"Add a dark mode to the Agent Web"\. An HQ update is waiting to go in .* starts right after the update\./);
  // Jarvis's status says the same, so "how's Einstein doing?" isn't answered with "nothing".
  const live = await jarvis.liveWorkText();
  assert.match(live, /Einstein: NOT started, held for the HQ update: "Add a dark mode to the Agent Web" \(asked 0 min ago by Phil\)\. It is saved and starts right after the update/);
  assert.match(live, /nothing is running, so HQ is rebuilding and restarting now \(two or three minutes\); the held workshop job starts once it is back\./);
  // A second one is held behind it, in order.
  await jarvis.runAgent(einstein, "Fix the JD PM texts", { direct: true, from: "Jarvis" });
  // While the update is still pending nothing resumes them.
  assert.equal(await jarvis.resumeHeldJobs(), 0);
  assert.deepEqual(seen, []);
  assert.equal((await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, [])).length, 2);

  // The restart: a new process on the same store, the ship settled as finishShip leaves it on boot.
  const next = make(store);
  next.jarvis.useWorkshop(new Workshop({ dir: path.join(root, "workshop"), appDir: app, verify: async () => ({ ok: true, report: "" }), pollMs: 20 }));
  await store.settings.set(SHIP_KEY, settled);
  assert.equal(await next.jarvis.resumeHeldJobs(), 2);
  assert.equal(next.seen.length, 2);
  assert.match(next.seen[0]!, /^Phil asks: Add a dark mode to the Agent Web/, "the first one asked starts first, as who asked it");
  assert.match(next.seen[1]!, /^Jarvis asks: Fix the JD PM texts/);
  assert.deepEqual(await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, []), [], "nothing left on the list");
  const chat = await store.chat.list(50);
  assert.ok(chat.some((m) => /Starting the job that was waiting for the HQ update: "Add a dark mode/.test(m.text)));
  assert.equal(chat.filter((m) => m.agentId === "einstein" && m.kind === "final").length, 2, "each answer goes to chat");
  assert.equal(await next.jarvis.resumeHeldJobs(), 0, "and they don't start twice");
  assert.doesNotMatch(await next.jarvis.liveWorkText(), /held/);
});

test("a job queued behind a running one is saved too: a restart starts it again instead of losing it", async () => {
  const { root, app } = await repo();
  const { store, jarvis, seen, keepGoing } = make();
  await store.init();
  jarvis.useWorkshop(new Workshop({ dir: path.join(root, "workshop"), appDir: app, verify: async () => ({ ok: true, report: "" }), pollMs: 20 }));
  const einstein = getAgent("einstein")!;
  const first = keepGoing(/the first task/);
  const a = jarvis.runAgent(einstein, "the first task", { direct: true });
  await first.running;
  const b = jarvis.runAgent(einstein, "the second task", { direct: true, from: "Stella" });
  assert.ok(await until(async () => (await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, [])).length === 1), "the queued job is on the list");
  const queued = (await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, []))[0]!;
  assert.equal(queued.task, "the second task"); assert.equal(queued.why, "queued"); assert.equal(queued.from, "Stella");
  // This process is still waiting on it, so nothing here starts it a second time.
  assert.equal(await jarvis.resumeHeldJobs(), 0);

  // HQ restarts (a crash, a deploy by hand) while it is queued: the new process finds it and starts it.
  const next = make(store);
  next.jarvis.useWorkshop(new Workshop({ dir: path.join(root, "workshop2"), appDir: app, verify: async () => ({ ok: true, report: "" }), pollMs: 20 }));
  assert.equal(await next.jarvis.resumeHeldJobs(), 1);
  assert.deepEqual(next.seen.map((p) => p.split("\n")[0]), ["Stella asks: the second task"]);
  assert.ok((await store.chat.list(50)).some((m) => /Starting the job that was waiting for the workshop when HQ restarted: "the second task"/.test(m.text)));

  // In a process that keeps running, the queued job starts when the first ends and comes off the list.
  first.finish();
  await a; await b;
  assert.equal(seen.filter((p) => /the second task/.test(p)).length, 1);
  assert.deepEqual(await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, []), []);
});

test("Nov 20 again: the update waits for the run in progress, not for the job queued behind it or a routine that came due", async () => {
  const { root, app } = await repo();
  const { store, jarvis, seen, keepGoing } = make();
  await store.init();
  await store.settings.set("phase", 1);
  const marker = path.join(root, "deploy-started");
  const w = new Workshop({ dir: path.join(root, "workshop"), appDir: app, verify: async () => ({ ok: true, report: "" }), pollMs: 20, deployCmd: `${process.execPath} -e require('fs').writeFileSync(${JSON.stringify(marker)},'go')` });
  jarvis.useWorkshop(w);
  const einstein = getAgent("einstein")!;
  const tip = await pushNewer(root);

  // Einstein is 31 minutes into a job, with another queued behind it, when Phil approves the update.
  const long = keepGoing(/the long job/);
  const a = jarvis.runAgent(einstein, "the long job", { direct: true });
  await long.running;
  const b = jarvis.runAgent(einstein, "the job queued behind it", { direct: true, from: "Jarvis" });
  assert.ok(await until(async () => /queued for the workshop/.test((await store.agentState.get("einstein"))?.detail ?? "")));
  const said = await w.update(store, tip, "Update HQ: 1 new change", "appr-1");
  assert.match(said, /einstein is mid-run, so the restart waits for that to finish \(up to 65 minutes\) and nothing new starts in the background meanwhile/);

  // The queued job is held within a poll, without waiting for the long one to end.
  const held = await b;
  assert.match(held.blocked ?? "", /held until the HQ update is in/);
  const jobs = await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, []);
  assert.equal(jobs.length, 1); assert.equal(jobs[0]!.task, "the job queued behind it"); assert.equal(jobs[0]!.why, "update");
  // A routine that comes due doesn't start either.
  const s = new Scheduler(jarvis, [{ id: "t-often", agentId: "stella", task: "Leads review", when: "every:30", phase: 1 }]);
  await s.tick();
  assert.deepEqual(await store.settings.get(DEFERRED_KEY, []), ["t-often"]);
  // The run in progress is never cut off: the deploy has not started.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await exists(marker), false, "the deploy waits for the run that was already going");
  assert.deepEqual(seen.map((p) => p.split("\n")[0]), ["Phil asks: the long job"], "and nothing else started");
  const live = await jarvis.liveWorkText();
  assert.match(live, /It is waiting for Einstein to finish \(a restart would cut the run off\)\. Nothing new starts in the background meanwhile: routines and watchers wait and run after the update, and the workshop job held above starts right after the restart\. It goes ahead when that run finishes, or in 65 min at the latest/);

  // The long job ends: the deploy starts at once, though a job and a routine are waiting.
  long.finish();
  await a;
  assert.ok(await until(() => exists(marker)), "the deploy started as soon as the run in progress finished");
  assert.deepEqual(seen.map((p) => p.split("\n")[0]), ["Phil asks: the long job"], "the held job and the routine still haven't started");
  assert.equal((await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, [])).length, 1);

  // HQ comes back on the new code: the held job and the routine run.
  git(app, "pull", "-q", "origin", "deploy");
  const next = make(store);
  const w2 = new Workshop({ dir: path.join(root, "workshop"), appDir: app, verify: async () => ({ ok: true, report: "" }), pollMs: 20, outcomeFile: path.join(root, "no-verdict.json") });
  next.jarvis.useWorkshop(w2);
  assert.match((await next.jarvis.finishShip({ wait: true })) ?? "", /Updated: HQ is back up/);
  assert.equal(await next.jarvis.resumeHeldJobs(), 1);
  await new Scheduler(next.jarvis, [{ id: "t-often", agentId: "stella", task: "Leads review", when: "every:30", phase: 1 }]).tick();
  assert.deepEqual(next.seen.map((p) => p.split("\n")[0]).slice(0, 2), ["Jarvis asks: the job queued behind it", "Scheduler asks: Leads review"]);
  assert.deepEqual(await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, []), []);
});
