import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Workshop, workshopTools, memoryStore, getAgent, Jarvis, mockProvider, ModelRouter } from "../src/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

/** A bare "GitHub" and a live checkout of it. */
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hq-workshop-lock-"));
  const app = path.join(root, "app");
  git(root, "init", "-q", "--bare", "-b", "deploy", "origin.git");
  git(root, "clone", "-q", path.join(root, "origin.git"), "app");
  git(app, "config", "user.email", "t@t"); git(app, "config", "user.name", "t");
  await fs.writeFile(path.join(app, "README.md"), "hq\n");
  git(app, "add", "-A"); git(app, "commit", "-q", "-m", "init"); git(app, "push", "-q", "-u", "origin", "HEAD:deploy"); git(app, "checkout", "-q", "deploy");
  return { root, app };
}

test("the workshop takes one run at a time: a second claim is refused until the first releases, or goes stale", () => {
  let now = Date.parse("2026-11-07T20:24:00Z");
  const w = new Workshop({ dir: "/nowhere/workshop", appDir: "/nowhere/app", now: () => new Date(now) });
  const first = w.claim("Phil shared Brian Armstrong's X post");
  assert.deepEqual(w.busy, { task: "Phil shared Brian Armstrong's X post", at: "2026-11-07T20:24:00.000Z" });
  assert.ok(w.holds(first)); assert.equal(w.holds(undefined), false); assert.equal(w.holds("someone-else"), false);
  now += 2 * 60_000;
  assert.throws(() => w.claim("Phil, Sat Nov 7, in full: yes send this"), /in use by another run of yours since 20:24 UTC \("Phil shared Brian Armstrong's X post"\); it frees up when that run ends/);
  w.release(first);
  assert.equal(w.busy, undefined);
  w.claim("second task");
  // A claim left behind by a run that died is not held forever.
  now += Workshop.LOCK_MS + 1;
  w.claim("third task");
  assert.equal(w.busy?.task, "third task");
});

test("release frees only the caller's own claim: a run that outlived its claim can't free the run that took over", () => {
  let now = Date.parse("2026-11-08T10:00:00Z");
  const w = new Workshop({ dir: "/nowhere/workshop", appDir: "/nowhere/app", now: () => new Date(now) });
  const slow = w.claim("a long refactor");
  // Someone without a claim, or with a made-up one, frees nothing.
  w.release("not-a-claim");
  assert.equal(w.busy?.task, "a long refactor");
  // The slow run passes 90 minutes; the next run takes the workshop over.
  now += Workshop.LOCK_MS + 1;
  const next = w.claim("a quick fix");
  assert.equal(w.holds(slow), false); assert.ok(w.holds(next));
  assert.match(w.refusal(slow)!, /in use by another run of yours since 11:30 UTC \("a quick fix"\)[\s\S]*this run's claim went stale and was taken over/);
  assert.equal(w.refusal(next), undefined);
  // The slow run finally ends: its release leaves the new run's claim alone, so a third run is still refused.
  w.release(slow);
  assert.equal(w.busy?.task, "a quick fix");
  assert.throws(() => w.claim("a third task"), /in use by another run of yours/);
  w.release(next);
  assert.equal(w.busy, undefined);
  assert.match(w.refusal(next)!, /no workshop open/);
});

test("workshop_status, verify and submit work only for the run that holds the workshop; a refused run commits nothing", async () => {
  const { root, app } = await repo();
  const dir = path.join(root, "workshop");
  let verified = 0;
  let onVerify: (() => void) | undefined;
  const w = new Workshop({ dir, appDir: app, verify: async () => { verified++; onVerify?.(); return { ok: true, report: "PASS all" }; } });
  const tools = workshopTools(w);
  const call = (name: string, args: Record<string, unknown>, workshopClaim?: string) => tools.find((t) => t.name === name)!.handler(args as never, { store: undefined as never, agentId: "einstein", workshopClaim });
  const submitArgs = { title: "Take the first run's work", why: "a second run must never be able to do this" };

  const first = await w.prepare("First run: make the clap louder");
  await fs.writeFile(path.join(dir, "README.md"), "hq\nthe first run's unfinished work\n");
  const head = git(dir, "rev-parse", "HEAD");

  // The second run was told the workshop is busy and holds no claim (or a made-up one): all three tools refuse.
  await assert.rejects(w.prepare("Second run"), /in use by another run of yours/);
  for (const claim of [undefined, "made-up"]) {
    assert.match(await call("workshop_status", {}, claim), /^Not shown: the workshop is in use by another run of yours since \d\d:\d\d UTC \("First run: make the clap louder"\)/);
    assert.match(await call("workshop_verify", {}, claim), /^Not run: the workshop is in use by another run of yours/);
    assert.match(await call("workshop_submit", submitArgs, claim), /^Not submitted: the workshop is in use by another run of yours[\s\S]*You can't change code this run/);
  }
  assert.doesNotMatch(await call("workshop_status", {}, undefined), /unfinished work/, "the other run's diff is not shown");
  assert.equal(verified, 0, "no checks were run for a refused run");
  assert.equal(git(dir, "rev-parse", "HEAD"), head, "nothing was committed");
  assert.match(git(dir, "status", "--porcelain"), /README\.md/, "the first run's file is still uncommitted");
  // The failed second prepare gave nothing back: the first run still holds the workshop and its tools work.
  assert.ok(w.holds(first.claim));
  assert.match(await call("workshop_status", {}, first.claim), /\+the first run's unfinished work/);
  assert.match(await call("workshop_verify", {}, first.claim), /^ALL GREEN/);

  // The claim is checked again after the checks: if the workshop changed hands while they ran, nothing is committed.
  onVerify = () => { w.release(first.claim); w.claim("Third run took over"); };
  assert.match(await call("workshop_submit", submitArgs, first.claim), /^Not submitted: the workshop is in use by another run of yours since \d\d:\d\d UTC \("Third run took over"\)/);
  assert.equal(git(dir, "rev-parse", "HEAD"), head, "still nothing committed");
  onVerify = undefined;

  // With nobody holding it, a run without a workshop is told so.
  const w2 = new Workshop({ dir, appDir: app, verify: async () => ({ ok: true, report: "" }) });
  assert.match(await workshopTools(w2).find((t) => t.name === "workshop_submit")!.handler(submitArgs as never, { store: undefined as never, agentId: "einstein" }), /^Not submitted: this run has no workshop open/);
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
});

test("two Einstein runs at once: the first gets the claim in its tool context, the second gets none and doesn't free the first's", async () => {
  const { root, app } = await repo();
  const store = memoryStore(); await store.init();
  const seen: { prompt: string; claim?: string; workspace: boolean }[] = [];
  let letFirstFinish!: () => void;
  const firstMayFinish = new Promise<void>((r) => { letFirstFinish = r; });
  let firstStarted!: () => void;
  const firstIsRunning = new Promise<void>((r) => { firstStarted = r; });
  const probe = { ...mockProvider("mock-claude"), async run(req: Parameters<ReturnType<typeof mockProvider>["run"]>[0]) {
    seen.push({ prompt: req.prompt, claim: req.toolContext?.workshopClaim, workspace: !!req.workspace });
    if (/first task/.test(req.prompt)) { firstStarted(); await firstMayFinish; }
    return mockProvider("mock-claude").run(req);
  } };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [probe], grok: [mockProvider("mock-grok")] } }) });
  const w = new Workshop({ dir: path.join(root, "workshop"), appDir: app, verify: async () => ({ ok: true, report: "" }) });
  jarvis.useWorkshop(w);
  const einstein = getAgent("einstein")!;
  const first = jarvis.runAgent(einstein, "the first task", { direct: true });
  await firstIsRunning;
  await jarvis.runAgent(einstein, "the second task", { direct: true });
  const a = seen.find((s) => /first task/.test(s.prompt))!; const b = seen.find((s) => /second task/.test(s.prompt))!;
  assert.ok(a.claim && a.workspace, "the first run holds the workshop");
  assert.equal(b.claim, undefined); assert.equal(b.workspace, false);
  // The second run has ended; the first still holds the workshop.
  assert.ok(w.holds(a.claim), "the second run ending did not free the first run's claim");
  assert.equal(w.busy?.task, "the first task");
  letFirstFinish();
  await first;
  assert.equal(w.busy, undefined, "the first run gave it back when it ended");
});
