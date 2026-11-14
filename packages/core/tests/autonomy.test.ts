import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Jarvis, ModelRouter, memoryStore, mockProvider, getAgent, Workshop, SHIP_KEY, AUTO_SHIP_KEY } from "../src/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

/** A bare "GitHub", the live checkout, and a second clone standing in for a Claude Code session that pushes. */
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hq-auto-"));
  const origin = path.join(root, "origin.git"), app = path.join(root, "app"), dev = path.join(root, "dev");
  git(root, "init", "-q", "--bare", "-b", "deploy", "origin.git");
  git(root, "clone", "-q", origin, "app");
  for (const d of [app]) { git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t"); }
  await fs.writeFile(path.join(app, "README.md"), "hq\n");
  git(app, "add", "-A"); git(app, "commit", "-q", "-m", "init"); git(app, "push", "-q", "-u", "origin", "HEAD:deploy"); git(app, "checkout", "-q", "deploy");
  git(root, "clone", "-q", "-b", "deploy", origin, "dev");
  git(dev, "config", "user.email", "c@c"); git(dev, "config", "user.name", "Claude");
  const push = async (file: string, text: string, msg: string) => { await fs.mkdir(path.dirname(path.join(dev, file)), { recursive: true }); await fs.writeFile(path.join(dev, file), text); git(dev, "add", "-A"); git(dev, "commit", "-q", "-m", msg); git(dev, "push", "-q", "origin", "HEAD:deploy"); return git(dev, "rev-parse", "HEAD"); };
  return { root, origin, app, dev, push };
}

function make(w?: Workshop, provider = mockProvider("mock-claude")) {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [mockProvider("mock-grok")] } }) });
  if (w) jarvis.useWorkshop(w);
  return { store, jarvis };
}

test("a run that hangs ends at its time limit and frees its agent; Phil hears why", async () => {
  const hang = { ...mockProvider("mock-claude"), run: () => new Promise<never>(() => undefined) };
  const { store, jarvis } = make(undefined, hang);
  const alive = setInterval(() => undefined, 1000); // stands in for the server, which keeps the process running
  const r = await jarvis.router.run(getAgent("stella")!, { system: "s", prompt: "p", direct: true, timeoutMs: 60 }).finally(() => clearInterval(alive));
  assert.match(r.blocked ?? "", /timed out after 0 minutes|timed out/);
  assert.equal((await store.agentState.get("stella"))?.status, "error");
  assert.equal((await store.runs.running()).length, 0, "the run row is closed");
});

test("new code on GitHub becomes one Update HQ card; approving it deploys; it's withdrawn once HQ is current", async () => {
  const { root, app, push } = await repo();
  const w = new Workshop({ dir: path.join(root, "workshop"), appDir: app, deployCmd: `${process.execPath} -e process.exit(0)`, outcomeFile: path.join(root, "out.json"), waitForRunsMs: 0, verify: async () => ({ ok: true, report: "" }) });
  const { store, jarvis } = make(w);
  assert.match(await jarvis.checkForUpdate(), /HQ is current/);
  assert.equal((await store.approvals.list("pending")).length, 0);
  await push("apps/hq/app/page.tsx", "x", "Home: a Now strip");
  const tip = await push("README.md", "hq\nmore\n", "Docs: how updates work");
  assert.match(await jarvis.checkForUpdate(), /2 new changes .*card queued/);
  assert.match(await jarvis.checkForUpdate(), /already waiting/, "no duplicate card");
  let cards = (await store.approvals.list("pending")).filter((a) => (a.payload as { action?: string }).action === "hq.update");
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.status, "pending", "an update never approves itself");
  assert.match(cards[0]!.body, /Docs: how updates work \(Claude, [0-9a-f]{7}\)[\s\S]*Home: a Now strip/, "newest first");
  assert.match(cards[0]!.effect ?? "", /Deploys the newest code on HQ's branch \(2 changes/);
  assert.equal((cards[0]!.payload as { sha?: string }).sha, tip);
  // Another push: the card is replaced by one for the newer tip.
  await push("README.md", "hq\nmore\nagain\n", "Docs again");
  await jarvis.checkForUpdate();
  cards = (await store.approvals.list("pending")).filter((a) => (a.payload as { action?: string }).action === "hq.update");
  assert.equal(cards.length, 1); assert.match(cards[0]!.title, /3 new changes/);
  // Phil approves: the deploy starts and the record says it's an update to the tip.
  const done = await jarvis.decide(cards[0]!.id, "approved");
  assert.match(done?.note ?? "", /Updating to [0-9a-f]{7}, 3 changes; HQ is rebuilding/);
  const rec = await store.settings.get<{ kind?: string; status?: string }>(SHIP_KEY, {});
  assert.equal(rec.kind, "update"); assert.equal(rec.status, "shipping");
  // The deploy lands (the live checkout moves to the tip); the next boot says so and the next check finds nothing.
  git(app, "pull", "-q", "origin", "deploy");
  assert.match((await jarvis.finishShip()) ?? "", /Updated: HQ is back up on [0-9a-f]{7}/);
  assert.match(await jarvis.checkForUpdate(), /HQ is current/);
  assert.match(await jarvis.command("/update"), /HQ is up to date/);
});

test("auto-ship is off until Phil turns it on; then only guardrail-free commits go out on their own, 3 a day", async () => {
  const { root, app } = await repo();
  const dir = path.join(root, "workshop");
  const w = new Workshop({ dir, appDir: app, token: "t0ken", deployCmd: `${process.execPath} -e process.exit(0)`, outcomeFile: path.join(root, "out.json"), waitForRunsMs: 0, verify: async () => ({ ok: true, report: "" }) });
  const { store, jarvis } = make(w);
  await w.prepare("change");
  const commit = async (file: string, msg: string) => { await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), msg); return (await w.commit(msg))!; };
  const ship = (sha: string, title: string) => jarvis.requestApproval({ agentId: "einstein", kind: "config", title: `Ship: ${title}`, body: "", payload: { action: "code.ship", sha, title, guardrails: [] }, runId: `r-${title}` });
  const off = await ship(await commit("apps/hq/app/about/page.tsx", "copy tweak"), "copy tweak");
  assert.equal(off.status, "pending", "off by default");
  await store.settings.set(AUTO_SHIP_KEY, true);
  // The card says no guardrails, but the commit's real files do: it waits, and the card says why.
  const sneaky = await ship(await commit("packages/core/src/jarvis/rules.ts", "loosen"), "loosen rules");
  assert.equal(sneaky.status, "pending");
  assert.match((await store.approvals.get(sneaky.id))?.note ?? "", /Not auto-shipped: it touches guardrails \(packages\/core\/src\/jarvis\/rules\.ts\)/);
  const ok: string[] = [];
  for (const t of ["a", "b", "c", "d"]) ok.push((await ship(await commit(`apps/hq/app/x-${t}.tsx`, t), t)).status);
  assert.deepEqual(ok, ["approved", "approved", "approved", "pending"], "three a day, then Phil decides");
});

test("Jarvis's live view lists only runs actually in progress, and says so when there are none", async () => {
  const { store, jarvis } = make();
  assert.match(await jarvis.liveWorkText(), /Working right now: nothing/);
  await store.runs.add({ id: "r1", agentId: "einstein", prompt: "Jarvis asks: redesign the home screen for clarity", status: "running", startedAt: new Date(Date.now() - 12 * 60_000).toISOString() });
  await store.runs.add({ id: "r2", agentId: "stella", prompt: "x", status: "done", startedAt: new Date().toISOString() });
  const t = await jarvis.liveWorkText();
  assert.match(t, /Einstein: working for 12 min on "redesign the home screen for clarity"/);
  assert.doesNotMatch(t, /Stella/);
  assert.match(t, /anything not listed has finished or stopped/);
});
