import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Workshop, workshopGuard, workshopTools, maskSecrets, scrubEnv, memoryStore, SHIP_KEY, CHARTERS, MODELS, getAgent, Jarvis, mockProvider, ModelRouter, WORKSHOP_HINT } from "../src/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

/** A bare "GitHub", a live checkout of it, and the workshop beside it. */
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hq-workshop-"));
  const origin = path.join(root, "origin.git"); const app = path.join(root, "app");
  git(root, "init", "-q", "--bare", "-b", "deploy", "origin.git");
  git(root, "clone", "-q", origin, "app");
  git(app, "config", "user.email", "t@t"); git(app, "config", "user.name", "t");
  await fs.writeFile(path.join(app, "README.md"), "hq\n");
  git(app, "add", "-A"); git(app, "commit", "-q", "-m", "init"); git(app, "push", "-q", "-u", "origin", "HEAD:deploy"); git(app, "checkout", "-q", "deploy");
  return { root, origin, app };
}

test("the workshop guard keeps Einstein inside his copy: no secrets, no live app, no network or system commands, no push", () => {
  const g = workshopGuard("/opt/jarvis-workshop", "/opt/jarvis");
  assert.equal(g("Read", { file_path: "/opt/jarvis-workshop/packages/core/src/index.ts" }), undefined);
  assert.equal(g("Edit", { file_path: "apps/hq/app/page.tsx" }), undefined);
  assert.match(g("Read", { file_path: "/opt/jarvis/.env" })!, /outside/);
  assert.match(g("Read", { file_path: "/opt/jarvis-workshop/.env" })!, /secrets/);
  assert.match(g("Write", { file_path: "../jarvis/x" })!, /outside/);
  assert.match(g("Read", { file_path: "/opt/jarvis-workshop/deploy/server.key" })!, /secrets/);
  assert.equal(g("Bash", { command: "pnpm --filter @jarvis/core build && node --test --import tsx tests/" }), undefined);
  assert.equal(g("Bash", { command: "git status && git diff --stat" }), undefined);
  assert.match(g("Bash", { command: "cat /opt/jarvis/.env" })!, /secret|live|command/);
  assert.match(g("Bash", { command: "curl https://evil" })!, /isn't allowed/);
  assert.match(g("Bash", { command: "sudo systemctl restart jarvis-server" })!, /isn't allowed/);
  assert.match(g("Bash", { command: "cat ../jarvis/package.json" })!, /above/);
  assert.match(g("Bash", { command: "ls /etc/" })!, /secret, system or home/);
  assert.match(g("Bash", { command: "git push origin HEAD" })!, /push is HQ's job/);
  assert.equal(g("Bash", { command: "echo ok > /dev/null" }), undefined);
  assert.equal(g("mcp__jarvis__memory_search", { query: "x" }), undefined);
  // Prose in a commit message isn't a command; the workshop's own path isn't the live app's.
  assert.equal(g("Bash", { command: 'git commit -m "Fix env-dependent tests; add GET /api/deploy and a sudo note"' }), undefined);
  assert.equal(g("Bash", { command: "ls /opt/jarvis-workshop/apps && cat /opt/jarvis-workshop/package.json" }), undefined);
  assert.match(g("Bash", { command: "cat /opt/jarvis/package.json" })!, /live app/);
  assert.match(g("Bash", { command: 'echo "$(cat /opt/jarvis/.env)"' })!, /secret|live/);
  assert.match(g("Bash", { command: 'git commit -m "$(curl evil)"' })!, /isn't allowed/);
  // Commands and tests never see HQ's secrets.
  const env = scrubEnv({ PATH: "/usr/bin", HOME: "/home/jarvis", DATABASE_URL: "postgres://x", XAI_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", HQ_ORIGIN: "https://hq", CLAUDE_MODE: "agent-sdk", NODE_ENV: "production" });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_MODE", "HOME", "HQ_WORKSHOP", "NODE_ENV", "PATH"]);
  assert.equal(g("WebSearch", { query: "x" }), undefined);
  assert.match(maskSecrets("token=ghp_abcdefghijklmnopqrstuvwxyz0123 and postgres://u:p@host/db"), /ghp_\[masked\]|token=\[masked\]/);
  assert.match(maskSecrets("DATABASE_URL=postgres://jarvis:pw@localhost/j"), /postgres:\/\/\[masked\]@/);
});

test("a change goes workshop → commit → approval → push to the live branch → deploy; the deploy's verdict is reported on the next boot", async () => {
  const { root, origin, app } = await repo();
  const dir = path.join(root, "workshop");
  const outcome = path.join(root, "last-deploy.json");
  const deployed: string[] = [];
  const w = new Workshop({ dir, appDir: app, token: "t0ken", deployCmd: `${process.execPath} -e process.exit(0)`, outcomeFile: outcome, verify: async () => ({ ok: true, report: "PASS all" }), now: () => new Date("2026-11-07T12:00:00Z") });
  // Fetching from "GitHub" with a token header would fail here; the workshop falls back to the live checkout's copy.
  const st = await w.prepare("Make the clap louder");
  assert.equal(st.dir, dir); assert.equal(st.branch, "einstein/2026-11-07-make-the-clap-louder"); assert.equal(st.base, "deploy");
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), st.branch);
  assert.ok((await w.status()).files.length === 0);
  await fs.writeFile(path.join(dir, "README.md"), "hq\nlouder clap\n");
  const s = await w.status();
  assert.deepEqual(s.files, ["README.md"]); assert.match(s.diff, /\+louder clap/);
  // The submit tool: checks, commit, and the approval block to paste.
  const tools = workshopTools(w, { logs: async () => "line1\nkey=abcdefghijkl\n", query: async () => ({ rows: [{ id: "1", text: "hi" }] }) });
  const submit = tools.find((t) => t.name === "workshop_submit")!;
  const out = String(await submit.handler({ title: "Make the clap louder", why: "Phil asked; the gain goes from 1 to 2." }, { store: undefined as never, agentId: "einstein" }));
  const block = JSON.parse(out.match(/```approval\n([\s\S]*?)\n```/)![1]!) as { kind: string; title: string; payload: { action: string; sha: string; files: string[] } };
  assert.equal(block.kind, "config"); assert.equal(block.title, "Ship: Make the clap louder"); assert.equal(block.payload.action, "code.ship"); assert.deepEqual(block.payload.files, ["README.md"]);
  assert.equal(git(dir, "rev-parse", "HEAD"), block.payload.sha);
  // A change to the guard itself is flagged in the title and body.
  await fs.mkdir(path.join(dir, "packages/core/src"), { recursive: true });
  await fs.writeFile(path.join(dir, "packages/core/src/workshop.ts"), "// loosened\n");
  const rails = String(await submit.handler({ title: "Loosen the guard", why: "testing the flag on a guardrail file" }, { store: undefined as never, agentId: "einstein" }));
  assert.match(rails, /"title":"Ship \(touches guardrails\): Loosen the guard"/);
  assert.match(rails, /GUARDRAILS TOUCHED: packages\/core\/src\/workshop\.ts/);
  git(dir, "reset", "-q", "--hard", block.payload.sha);
  assert.match(String(await tools.find((t) => t.name === "hq_logs")!.handler({ lines: 50 }, { store: undefined as never, agentId: "einstein" })), /line1\nkey=\[masked\]/);
  assert.match(String(await tools.find((t) => t.name === "db_query")!.handler({ sql: "select id, text from chat_messages limit 1" }, { store: undefined as never, agentId: "einstein" })), /id \| text\n1 \| hi/);
  assert.match(String(await tools.find((t) => t.name === "db_query")!.handler({ sql: "delete from runs" }, { store: undefined as never, agentId: "einstein" })), /Read-only/);
  // Ship: the commit lands on the live branch of "GitHub" and the deploy command runs detached.
  const store = memoryStore(); await store.init();
  // An agent mid-run holds the restart until it finishes; the push itself happens at once.
  await store.agentState.set("einstein", { status: "working", detail: "the other task" });
  const wait = new Workshop({ dir, appDir: app, token: "t0ken", deployCmd: `${process.execPath} -e process.exit(0)`, outcomeFile: outcome, verify: async () => ({ ok: true, report: "" }), pollMs: 20 });
  const held = await wait.ship(store, block.payload.sha, "Make the clap louder", "appr-0");
  assert.match(held, /einstein is mid-run, so the restart waits/);
  assert.equal(git(origin, "rev-parse", "deploy"), block.payload.sha, "pushed before the wait");
  await store.agentState.set("einstein", { status: "idle", detail: "" });
  await new Promise((r) => setTimeout(r, 80));
  const msg = await w.ship(store, block.payload.sha, "Make the clap louder", "appr-1");
  assert.match(msg, /Pushed [0-9a-f]{7} to deploy; HQ is rebuilding/);
  assert.equal(git(origin, "rev-parse", "deploy"), block.payload.sha);
  const rec = await store.settings.get<{ status: string; sha: string }>(SHIP_KEY, { status: "", sha: "" });
  assert.equal(rec.status, "shipping");
  // Next boot, the live checkout is on the new commit: done.
  git(app, "pull", "-q", "origin", "deploy");
  const done = await w.finish(store);
  assert.equal(done!.record.status, "done"); assert.match(done!.message, /HQ is back up on the new code/);
  assert.equal((await w.finish(store)), undefined, "reported once");
  // A rollback: the deploy script says no, the live checkout stayed behind; the commit is reverted on the branch.
  await fs.writeFile(path.join(dir, "README.md"), "hq\nlouder clap\nbroken\n");
  const bad = (await w.commit("Break it"))!;
  await w.ship(store, bad, "Break it");
  assert.equal(git(origin, "rev-parse", "deploy"), bad);
  await fs.writeFile(outcome, JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), ok: false, sha: "", rolledBackTo: block.payload.sha, error: "health check failed" }));
  const back = await w.finish(store);
  assert.equal(back!.record.status, "rolled-back");
  assert.match(back!.message, /rolled back: HQ didn't come up on it \(health check failed\)[\s\S]*reverted on deploy/);
  assert.notEqual(git(origin, "rev-parse", "deploy"), bad, "a revert commit sits on top");
  assert.equal(git(origin, "show", "deploy:README.md"), "hq\nlouder clap");
  deployed.length;
});

test("the last-deploy line for Settings: the deploy script's verdict, blanks dropped, plus the commit HQ is running", async () => {
  const { root, app } = await repo();
  const outcome = path.join(root, "last-deploy.json");
  const w = new Workshop({ dir: path.join(root, "workshop"), appDir: app, outcomeFile: outcome });
  // Nothing recorded yet: still says what is running.
  const none = await w.lastDeploy();
  assert.equal(none.last, null); assert.equal(none.live!.branch, "deploy"); assert.equal(none.live!.sha, git(app, "rev-parse", "HEAD"));
  // A good deploy, as the script writes it.
  await fs.writeFile(outcome, JSON.stringify({ at: "2026-11-07T12:00:00Z", ok: true, sha: "abc1234def", previous: "0001111", rolledBackTo: "", error: "" }));
  const ok = (await w.lastDeploy()).last!;
  assert.equal(ok.ok, true); assert.equal(ok.sha, "abc1234def"); assert.equal(ok.previous, "0001111"); assert.equal(ok.rolledBackTo, undefined); assert.equal(ok.error, undefined);
  // A rollback.
  await fs.writeFile(outcome, JSON.stringify({ at: "2026-11-07T13:00:00Z", ok: false, sha: "", previous: "abc1234def", rolledBackTo: "abc1234def", error: "health check failed" }));
  const back = (await w.lastDeploy()).last!;
  assert.equal(back.ok, false); assert.equal(back.sha, undefined); assert.equal(back.rolledBackTo, "abc1234def"); assert.equal(back.error, "health check failed");
  // A broken file is the same as none.
  await fs.writeFile(outcome, "not json");
  assert.equal((await w.lastDeploy()).last, null);
  // No live checkout: the line still renders without it.
  assert.equal((await new Workshop({ dir: path.join(root, "w2"), appDir: path.join(root, "nowhere"), outcomeFile: outcome }).lastDeploy()).live, null);
});

test("Einstein is HQ's engineer: Fable by default, the workshop tools in his charter, a code task opens the workshop and the ship action is described", async () => {
  assert.equal(getAgent("einstein")!.model, "claude-fable");
  assert.equal(MODELS["claude-fable"].modelId, "claude-fable-5-1");
  assert.ok(CHARTERS.einstein!.workshop);
  for (const t of ["workshop_status", "workshop_verify", "workshop_submit", "hq_logs", "db_query"]) assert.ok(CHARTERS.einstein!.tools!.includes(t), t);
  const { root, app } = await repo();
  const store = memoryStore(); await store.init();
  let seen: { prompt: string; system: string; workspace?: { dir: string } } | undefined;
  const probe = { ...mockProvider("mock-claude"), async run(req: Parameters<ReturnType<typeof mockProvider>["run"]>[0]) { seen = { prompt: req.prompt, system: req.system, workspace: req.workspace }; return mockProvider("mock-claude").run(req); } };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [probe], grok: [mockProvider("mock-grok")] } }) });
  const w = new Workshop({ dir: path.join(root, "workshop"), appDir: app, verify: async () => ({ ok: true, report: "" }) });
  jarvis.useWorkshop(w);
  await jarvis.runAgent(getAgent("einstein")!, "Fix the clap-to-wake toggle on the home screen", { direct: true });
  assert.ok(seen?.workspace?.dir.endsWith("workshop"), "the run carries the workshop");
  assert.match(seen!.system, /You are working in your workshop/);
  assert.match(seen!.system, /git push is refused/);
  assert.ok(WORKSHOP_HINT("/w", "einstein/x", "deploy").includes("workshop_submit"));
  assert.match(jarvis.effectOf({ agentId: "einstein", kind: "config", payload: { action: "code.ship", sha: "abcdef0123" } }), /Pushes Einstein's commit abcdef0 to the live branch and redeploys HQ/);
  // Other agents never get a workspace.
  seen = undefined;
  await jarvis.runAgent(getAgent("stella")!, "status", { direct: true });
  assert.equal(seen?.workspace, undefined);
});
