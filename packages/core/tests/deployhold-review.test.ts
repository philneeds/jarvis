import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Jarvis, ModelRouter, Scheduler, Workshop, GoHighLevelConnector, memoryStore, mockProvider, getAgent, DEFERRED_KEY, HELD_JOBS_KEY, SHIP_KEY, type HeldJob, type Schedule, type Store } from "../src/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const until = async (ok: () => Promise<boolean> | boolean, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
const exists = (f: string) => fs.stat(f).then(() => true).catch(() => false);
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hq-review-"));
  const app = path.join(root, "app");
  git(root, "init", "-q", "--bare", "-b", "deploy", "origin.git");
  git(root, "clone", "-q", path.join(root, "origin.git"), "app");
  git(app, "config", "user.email", "t@t"); git(app, "config", "user.name", "t");
  await fs.writeFile(path.join(app, "README.md"), "hq\n");
  git(app, "add", "-A"); git(app, "commit", "-q", "-m", "init"); git(app, "push", "-q", "-u", "origin", "HEAD:deploy"); git(app, "checkout", "-q", "deploy");
  return { root, app };
}
async function pushNewer(root: string) {
  git(root, "clone", "-q", path.join(root, "origin.git"), "session");
  const s = path.join(root, "session");
  git(s, "config", "user.email", "c@c"); git(s, "config", "user.name", "c");
  await fs.writeFile(path.join(s, "README.md"), "hq\nnewer\n");
  git(s, "add", "-A"); git(s, "commit", "-q", "-m", "a newer change"); git(s, "push", "-q", "origin", "HEAD:deploy");
  return git(s, "rev-parse", "HEAD");
}
function probe() {
  const seen: string[] = [];
  const gates = new Map<RegExp, { started: () => void; done: Promise<void> }>();
  const base = mockProvider("mock-claude");
  const provider = { ...base, async run(req: Parameters<typeof base.run>[0]) {
    seen.push(req.prompt);
    for (const [re, g] of gates) if (re.test(req.prompt)) { g.started(); await g.done; }
    return base.run(req);
  } };
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
const approved = (at: Date | number = Date.now()) => ({ at: new Date(at).toISOString(), sha: "abc1234abc1234", title: "Update HQ", status: "shipping", kind: "update" });

test("an update approved while a tick is going: the routines after it in that tick wait for it too", async () => {
  const { store, jarvis, seen, keepGoing } = make();
  await store.init();
  await store.settings.set("phase", 1);
  const one: Schedule = { id: "r-one", agentId: "stella", task: "Routine one", when: "every:30", phase: 1 };
  const two: Schedule = { id: "r-two", agentId: "karol", task: "Routine two", when: "every:30", phase: 1 };
  const s = new Scheduler(jarvis, [one, two]);
  const g = keepGoing(/Routine one/);
  const t = s.tick();
  await g.running;
  // Phil approves the update while routine one is mid-run.
  await store.settings.set(SHIP_KEY, approved());
  g.finish();
  await t;
  const started2 = seen.filter((p) => /Routine two/.test(p)).length;
  assert.equal(started2, 0, "routine two started even though an update was pending");
});

test("a held job doesn't leave Einstein shown as working, so the deploy doesn't wait for him to its cap", async () => {
  const { root, app } = await repo();
  const { store, jarvis, seen } = make();
  await store.init();
  const marker = path.join(root, "deploy-started");
  const w = new Workshop({ dir: path.join(root, "workshop"), appDir: app, verify: async () => ({ ok: true, report: "" }), pollMs: 20, waitForRunsMs: 1500, deployCmd: `${process.execPath} -e require('fs').writeFileSync(${JSON.stringify(marker)},'go')` });
  jarvis.useWorkshop(w);
  const einstein = getAgent("einstein")!;
  const tip = await pushNewer(root);
  // The workshop is busy with another job still preparing (claim taken, no router.run yet: e.g. a fresh install).
  const claim = w.claim("job one, still installing");
  const b = jarvis.runAgent(einstein, "job two", { direct: true });
  assert.ok(await until(async () => /queued for the workshop/.test((await store.agentState.get("einstein"))?.detail ?? "")));
  const said = await w.update(store, tip, "Update HQ", "appr-1");
  const r = await b;
  assert.match(r.blocked ?? "", /held until/);
  // Job one's prepare finishes; its own post-prepare hold check makes it release and be held too (simulate).
  w.release(claim);
  const st = await store.agentState.get("einstein");
  await new Promise((r) => setTimeout(r, 500));
  const startedEarly = await exists(marker);
  assert.notEqual(st?.status, "working", "Einstein is shown working though nothing runs");
});

test("GoHighLevel: one calendar failing keeps the others' appointments and the connection", async () => {
  const store = memoryStore(); await store.init();
  const f = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.pathname === "/calendars/") return Response.json({ calendars: [{ id: "cal1", name: "Estimates" }, { id: "cal2", name: "Installs" }] });
    if (u.pathname === "/calendars/events") {
      if (u.searchParams.get("calendarId") === "cal2") return Response.json({ message: "Internal" }, { status: 500 });
      return Response.json({ events: [{ id: "e1", title: "Estimate", startTime: "2026-11-09T15:00:00Z", endTime: "2026-11-09T16:00:00Z" }] });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const g = new GoHighLevelConnector(store, { apiKey: "k", locationId: "loc1", fetch: f });
  const out = await g.appointments(7).then((a) => `ok ${a.length}`, (e) => `threw: ${(e as Error).message}`);
  assert.match(out, /^ok 1/, "cal1's appointment should still come back");
  assert.notEqual((await store.settings.get<{ ok?: boolean } | null>("ghl.status", null))?.ok, false, "one calendar's error isn't the connection lost");
  assert.match(g.appointmentsText(await g.appointments(7), 7), /Couldn't read one calendar, so this may be missing some: Installs/);
});

test("GoHighLevel: no calendars means no appointments and no events call", async () => {
  const store = memoryStore(); await store.init();
  let ev = 0;
  const f = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.pathname === "/calendars/") return Response.json({ calendars: [{ id: "c", name: "Old", isActive: false }] });
    if (u.pathname === "/calendars/events") { ev++; return Response.json({ events: [] }); }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const g = new GoHighLevelConnector(store, { apiKey: "k", locationId: "loc1", fetch: f });
  const t = g.tools().find((x) => x.name === "ghl_appointments")!;
});

test("a held queued job resumes once, however many ticks ask", async () => {
  const { root, app } = await repo();
  const { store, jarvis, seen } = make();
  await store.init();
  jarvis.useWorkshop(new Workshop({ dir: path.join(root, "workshop"), appDir: app, verify: async () => ({ ok: true, report: "" }), pollMs: 20 }));
  await store.settings.set(SHIP_KEY, approved());
  await jarvis.runAgent(getAgent("einstein")!, "held job A", { direct: true });
  await jarvis.runAgent(getAgent("einstein")!, "held job B", { direct: true });
  await store.settings.set(SHIP_KEY, { ...approved(), status: "done" });
  const calls = await Promise.all([jarvis.resumeHeldJobs(), jarvis.resumeHeldJobs(), jarvis.resumeHeldJobs()]);
  const starts = (await store.chat.list(100)).filter((m) => /Starting the job/.test(m.text)).length;
  assert.equal(seen.length, 2); assert.equal(starts, 2);
  assert.deepEqual(await store.settings.get<HeldJob[]>(HELD_JOBS_KEY, []), []);
});

test("a routine held for an update runs once after it, not again from the held list", async () => {
  const store = memoryStore(); await store.init(); await store.settings.set("phase", 1);
  const seen: string[] = []; let finish!: () => void, started!: () => void;
  const done = new Promise<void>((r) => { finish = r; }); const running = new Promise<void>((r) => { started = r; });
  const base = mockProvider("mock-claude");
  const provider = { ...base, async run(req: Parameters<typeof base.run>[0]) { seen.push(req.prompt.split("\n")[0]!); if (/Routine X/.test(req.prompt)) { started(); await done; } return base.run(req); } };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [mockProvider("mock-grok")] } }) });
  const X: Schedule = { id: "x", agentId: "stella", task: "Routine X", when: "daily@06:50", phase: 1 };
  const Y: Schedule = { id: "y", agentId: "karol", task: "Routine Y", when: "daily@06:50", phase: 1 };
  const s = new Scheduler(jarvis, [X, Y]);
  const at = (h: number, m: number) => new Date(2026, 10, 20, h, m);
  const tA = s.tick(at(6, 50)); await running;
  await store.settings.set(SHIP_KEY, { at: at(6, 51).toISOString(), sha: "abc1234", title: "U", status: "shipping", kind: "update" });
  await s.tick(at(6, 52));
  finish(); await tA;
  await store.settings.set(SHIP_KEY, { at: at(6, 51).toISOString(), sha: "abc1234", title: "U", status: "done", kind: "update" });
  await new Scheduler(jarvis, [X, Y]).tick(at(7, 20));
  const y = seen.filter((p) => /^Scheduler asks: Routine Y/.test(p)).length;
  assert.equal(y, 1);
});

test("held jobs start oldest first", async () => {
  const { HeldJobs } = await import("../src/index.js");
  const store = memoryStore(); await store.init();
  const h = new HeldJobs(store);
  await h.keep({ id: "b", agentId: "einstein", task: "two", at: "2026-11-21T10:05:00Z", why: "update" }, false);
  await h.keep({ id: "a", agentId: "einstein", task: "one", at: "2026-11-21T10:00:00Z", why: "update" }, false);
  assert.deepEqual((await h.take()).map((j) => j.id), ["a", "b"]);
});
