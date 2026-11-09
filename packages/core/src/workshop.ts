import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Store } from "./store/types.js";

/**
 * Einstein's workshop: a separate copy of HQ's code where he can read, edit and test. Nothing he does there touches the
 * live app or its secrets. A change leaves the workshop only as an approval on Phil's Needs You card (diff, tests,
 * reason); when Phil approves, HQ pushes the commit to the deploy branch, runs the deploy script and checks its own
 * health; if HQ doesn't come back, the deploy script rolls back and HQ reverts the commit on the branch.
 *   WORKSHOP_DIR         the working copy (default /opt/jarvis-workshop; a sibling of the app dir in development)
 *   GITHUB_PUSH_TOKEN    a fine-grained token with Contents: write on the repo; without it changes can be prepared
 *                        and approved but not shipped
 *   WORKSHOP_DEPLOY_CMD  how a ship is applied (default: sudo -n /usr/local/bin/jarvis-deploy, installed by setup.sh)
 *   WORKSHOP_OUTCOME     where the deploy script reports (default /var/lib/jarvis/last-deploy.json)
 */
export type Runner = (cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<{ code: number; out: string }>;

/**
 * The environment Einstein's commands and tests run with: the shell basics and nothing from HQ's .env. A test process
 * can read process.env, so secrets must never be there to read.
 */
const KEEP_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|NODE_ENV|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|PNPM_HOME|COREPACK_[A-Z_]+|XDG_[A-Z_]+|CLAUDE_[A-Z_]+|GIT_[A-Z_0-9]+|NO_COLOR|FORCE_COLOR|CI|SSL_CERT_FILE|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|https_proxy|http_proxy|no_proxy)$/;
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && KEEP_ENV.test(k) && !/API_?KEY|_TOKEN|SECRET|PASSWORD|PRIVATE/i.test(k)) out[k] = v;
  out.HQ_WORKSHOP = "1";
  return out;
}

export const defaultRunner: Runner = (cmd, args, opts) => new Promise((resolve) => {
  let out = "";
  const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...scrubEnv(), ...(opts.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => { out += d.toString(); });
  p.stderr.on("data", (d) => { out += d.toString(); });
  const t = setTimeout(() => { p.kill("SIGTERM"); out += `\n(timed out after ${Math.round((opts.timeoutMs ?? 600_000) / 1000)}s)`; }, opts.timeoutMs ?? 600_000);
  p.on("error", (e) => { clearTimeout(t); resolve({ code: 127, out: `${out}\n${e.message}` }); });
  p.on("exit", (code) => { clearTimeout(t); resolve({ code: code ?? 1, out }); });
});

export interface WorkshopOptions {
  dir: string;
  /** The live checkout (its origin and branch are the deploy target). */
  appDir: string;
  token?: string;
  deployCmd?: string;
  outcomeFile?: string;
  run?: Runner;
  /** The checks a change must pass before it can be submitted; default: build, typecheck and tests of every package. */
  verify?: (dir: string) => Promise<{ ok: boolean; report: string }>;
  now?: () => Date;
  /** How long a ship waits for agents mid-run before restarting HQ (default 25 minutes; 0 = don't wait). */
  waitForRunsMs?: number;
  pollMs?: number;
}
export interface WorkshopState { dir: string; branch: string; base: string }
export interface ShipRecord { at: string; sha: string; title: string; approvalId?: string; previous?: string; status: "shipping" | "done" | "rolled-back" | "failed"; note?: string }
/** What the deploy script writes after each run: Einstein's ships and deploys by hand alike. */
export interface DeployOutcome { at: string; ok: boolean; sha?: string; previous?: string; rolledBackTo?: string; error?: string }
export interface DeployStatus { last: DeployOutcome | null; live: { sha: string; branch: string } | null }
export const SHIP_KEY = "workshop.ship";
const SLUG = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";

export class Workshop {
  private run: Runner;
  private state?: WorkshopState;
  constructor(private opts: WorkshopOptions) { this.run = opts.run ?? defaultRunner; }

  static fromEnv(appDir = process.cwd()): Workshop | undefined {
    if (process.env.WORKSHOP_DIR === "off") return undefined;
    const dir = process.env.WORKSHOP_DIR || (process.env.NODE_ENV === "production" ? "/opt/jarvis-workshop" : path.join(path.dirname(appDir), "jarvis-workshop"));
    return new Workshop({ dir, appDir, token: process.env.GITHUB_PUSH_TOKEN, deployCmd: process.env.WORKSHOP_DEPLOY_CMD, outcomeFile: process.env.WORKSHOP_OUTCOME });
  }

  get dir() { return this.opts.dir; }
  get current() { return this.state; }

  /**
   * One run at a time. Two of Einstein's runs in the same workshop would check out each other's branches and sweep
   * each other's uncommitted files into their commits (it happened on Nov 7). The second run is told the workshop is
   * busy and works without code changes; a claim older than LOCK_MS is treated as abandoned.
   */
  static LOCK_MS = 90 * 60_000;
  private inUse?: { id: string; task: string; at: number };
  private heldBy(u: { task: string; at: number }) { return `the workshop is in use by another run of yours since ${new Date(u.at).toISOString().slice(11, 16)} UTC ("${u.task.replace(/\s+/g, " ").slice(0, 80)}")`; }
  /** Take the workshop for one run. Returns the claim that run shows to use the workshop tools and to give it back. */
  claim(task: string): string {
    const now = (this.opts.now?.() ?? new Date()).getTime();
    if (this.inUse && now - this.inUse.at < Workshop.LOCK_MS) throw new Error(`${this.heldBy(this.inUse)}; it frees up when that run ends`);
    const id = randomUUID();
    this.inUse = { id, task, at: now };
    return id;
  }
  /** Does this claim hold the workshop right now? A run that was refused, or whose stale claim was taken over, doesn't. */
  holds(claim?: string): boolean { return !!claim && this.inUse?.id === claim; }
  /** Why a run with this claim can't use the workshop; nothing when it holds it. */
  refusal(claim?: string): string | undefined {
    if (this.holds(claim)) return undefined;
    if (!this.inUse) return "this run has no workshop open, so there is nothing of yours to show, check or submit";
    return `${this.heldBy(this.inUse)}, and what is in it is that run's work, not this one's${claim ? " (this run's claim went stale and was taken over)" : ""}`;
  }
  /** Give the workshop back. Only the run that holds it can: a run that outlived its claim doesn't free the next run's. */
  release(claim: string) { if (this.holds(claim)) this.inUse = undefined; }
  get busy(): { task: string; at: string } | undefined { return this.inUse ? { task: this.inUse.task, at: new Date(this.inUse.at).toISOString() } : undefined; }

  private git(args: string[], cwd = this.opts.dir, env?: Record<string, string>) { return this.run("git", args, { cwd, env, timeoutMs: 120_000 }); }
  private async must(args: string[], cwd = this.opts.dir, env?: Record<string, string>) {
    const r = await this.git(args, cwd, env);
    if (r.code !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${r.out.trim().slice(-400)}`);
    return r.out.trim();
  }

  /** The deploy branch and the GitHub remote, read from the live checkout. */
  async target(): Promise<{ branch: string; remote: string }> {
    const branch = (await this.must(["rev-parse", "--abbrev-ref", "HEAD"], this.opts.appDir)) || "main";
    const raw = await this.must(["remote", "get-url", "origin"], this.opts.appDir);
    // Credentials the installer put in the URL stay out of the workshop; pushes use GITHUB_PUSH_TOKEN.
    const remote = raw.replace(/^https:\/\/[^@/]+@/, "https://");
    return { branch, remote };
  }

  /** The push token as a git header, never on the command line. */
  private auth(): Record<string, string> | undefined {
    if (!this.opts.token) return undefined;
    return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${this.opts.token}`).toString("base64")}`, GIT_TERMINAL_PROMPT: "0" };
  }

  /** A clean branch off the deploy branch, dependencies installed; ready for Einstein to work in. */
  async prepare(task: string): Promise<WorkshopState & { claim: string }> {
    const claim = this.claim(task);
    try { return { ...(await this.prepareUnlocked(task)), claim }; }
    catch (e) { this.release(claim); throw e; }
  }
  private async prepareUnlocked(task: string): Promise<WorkshopState> {
    const { branch, remote } = await this.target();
    const dir = this.opts.dir;
    const exists = await fs.stat(path.join(dir, ".git")).then(() => true).catch(() => false);
    if (!exists) {
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await this.must(["clone", "-q", this.opts.appDir, dir], path.dirname(dir));
      await this.must(["remote", "set-url", "origin", remote]);
      await this.must(["config", "user.name", "Einstein (HQ)"]);
      await this.must(["config", "user.email", "einstein@hq.local"]);
    }
    // Fresh base: the deploy branch as it is on GitHub (or as the live app has it, when GitHub can't be reached).
    const fetched = await this.git(["fetch", "-q", "origin", branch], dir, this.auth());
    const base = fetched.code === 0 ? `origin/${branch}` : await this.must(["rev-parse", "HEAD"], this.opts.appDir);
    if (fetched.code !== 0) await this.must(["fetch", "-q", this.opts.appDir, branch]);
    const work = `einstein/${(this.opts.now?.() ?? new Date()).toISOString().slice(0, 10)}-${SLUG(task)}`;
    await this.must(["checkout", "-q", "-B", work, fetched.code === 0 ? base : "FETCH_HEAD"]);
    await this.must(["reset", "-q", "--hard"]);
    await this.must(["clean", "-fdq", "-e", "node_modules", "-e", ".env"]);
    const hasModules = await fs.stat(path.join(dir, "node_modules")).then(() => true).catch(() => false);
    const hasManifest = await fs.stat(path.join(dir, "package.json")).then(() => true).catch(() => false);
    if (!hasModules && hasManifest) {
      const r = await this.run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: dir, timeoutMs: 900_000 });
      if (r.code !== 0) throw new Error(`pnpm install failed in the workshop: ${r.out.trim().slice(-400)}`);
    }
    this.state = { dir, branch: work, base: branch };
    return this.state;
  }

  /** What's changed so far: files, stat, and the diff (capped). */
  async status(): Promise<{ branch: string; files: string[]; stat: string; diff: string }> {
    const files = (await this.git(["status", "--porcelain"])).out.split("\n").filter((l) => l.trim()).map((l) => l.replace(/^.{2}\s/, "").trim());
    const stat = await this.must(["diff", "--stat", "HEAD"]);
    const diff = await this.must(["diff", "HEAD"]);
    return { branch: this.state?.branch ?? (await this.must(["rev-parse", "--abbrev-ref", "HEAD"])), files, stat, diff: diff.length > 20_000 ? `${diff.slice(0, 20_000)}\n… (diff cut at 20k characters)` : diff };
  }

  /** Build, typecheck and test every package; a change that fails here can't be submitted. */
  async verify(): Promise<{ ok: boolean; report: string }> {
    if (this.opts.verify) return this.opts.verify(this.opts.dir);
    const dir = this.opts.dir;
    const steps: [string, string, string[], string][] = [
      ["core build", "pnpm", ["--filter", "@jarvis/core", "build"], dir],
      // Each package's own test script (node --test with the tests/*.test.ts glob): a bare "tests/" is not a test
      // file to node 22, which tries to import the directory and fails.
      ["core tests", "pnpm", ["test"], path.join(dir, "packages/core")],
      ["server typecheck", "pnpm", ["exec", "tsc", "--noEmit", "-p", "."], path.join(dir, "apps/server")],
      ["server tests", "pnpm", ["test"], path.join(dir, "apps/server")],
      ["hq typecheck", "pnpm", ["exec", "tsc", "--noEmit", "-p", "."], path.join(dir, "apps/hq")],
    ];
    const lines: string[] = [];
    let ok = true;
    for (const [name, cmd, args, cwd] of steps) {
      const r = await this.run(cmd, args, { cwd, timeoutMs: 600_000 });
      const pass = r.code === 0;
      ok &&= pass;
      const tail = r.out.split("\n").filter((l) => /^# (pass|fail)|error TS|not ok|Error:/.test(l)).slice(-6).join("\n");
      lines.push(`${pass ? "PASS" : "FAIL"} ${name}${tail ? `\n${tail}` : ""}`);
      if (!pass) { lines.push(r.out.trim().slice(-1500)); break; }
    }
    return { ok, report: lines.join("\n") };
  }

  /** Commit everything in the workshop; the sha is what Phil approves. */
  async commit(message: string): Promise<string | undefined> {
    await this.must(["add", "-A"]);
    const staged = await this.must(["diff", "--cached", "--stat"]);
    if (!staged) return undefined;
    await this.must(["commit", "-q", "-m", message]);
    return this.must(["rev-parse", "HEAD"]);
  }

  /** The commit's message, files and diff, for the approval card. */
  async describe(sha: string): Promise<{ title: string; files: string[]; stat: string }> {
    const title = await this.must(["log", "-1", "--format=%s", sha]);
    const files = (await this.must(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])).split("\n").filter(Boolean);
    const stat = await this.must(["show", "--stat", "--format=", sha]);
    return { title, files, stat };
  }

  /**
   * Phil approved: push the commit to the deploy branch and start the deploy. The deploy restarts HQ itself, so the
   * result is read on the next boot (finish()). Returns what to tell Phil now.
   */
  async ship(store: Store, sha: string, title: string, approvalId?: string): Promise<string> {
    if (!this.opts.token) throw new Error("GITHUB_PUSH_TOKEN isn't set, so HQ can't push to GitHub. Add a fine-grained token with Contents: write on the repo to /opt/jarvis/.env and approve again.");
    const { branch } = await this.target();
    const previous = await this.must(["rev-parse", "HEAD"], this.opts.appDir);
    // Fast-forward if possible; otherwise bring the change onto the branch's tip first.
    let push = await this.git(["push", "-q", "origin", `${sha}:refs/heads/${branch}`], this.opts.dir, this.auth());
    if (push.code !== 0 && /rejected|fetch first|non-fast-forward/i.test(push.out)) {
      await this.must(["fetch", "-q", "origin", branch], this.opts.dir, this.auth());
      await this.must(["checkout", "-q", "--detach", sha]);
      const rebase = await this.git(["rebase", `origin/${branch}`]);
      if (rebase.code !== 0) { await this.git(["rebase", "--abort"]); throw new Error(`the change no longer applies cleanly on ${branch}; ask Einstein to redo it on the current code`); }
      const moved = await this.must(["rev-parse", "HEAD"]);
      push = await this.git(["push", "-q", "origin", `${moved}:refs/heads/${branch}`], this.opts.dir, this.auth());
      sha = moved;
    }
    if (push.code !== 0) throw new Error(`push to ${branch} failed: ${push.out.trim().slice(-300)}`);
    const rec: ShipRecord = { at: new Date().toISOString(), sha, title, approvalId, previous, status: "shipping" };
    await store.settings.set(SHIP_KEY, rec);
    const cmd = this.opts.deployCmd ?? "sudo -n /usr/local/bin/jarvis-deploy";
    const [bin, ...args] = cmd.split(" ");
    // Detached: the deploy restarts this very process.
    const start = () => { const p = spawn(bin!, args, { cwd: this.opts.appDir, detached: true, stdio: "ignore", env: { ...process.env, JARVIS_SHIP_SHA: sha } }); p.on("error", () => undefined); p.unref(); };
    // The restart would cut off any agent mid-run (Einstein's other task, a lead's routine), so wait for them first,
    // up to WAIT_FOR_RUNS_MS; the ship record already says this commit is going out.
    const busy = (await store.agentState.all()).filter((s) => s.status === "working").map((s) => s.id);
    if (!busy.length || this.opts.waitForRunsMs === 0) { start(); return `Pushed ${sha.slice(0, 7)} to ${branch}; HQ is rebuilding and will restart in two or three minutes. If it doesn't come back up, the deploy rolls back to ${previous.slice(0, 7)} on its own and I'll say so.`; }
    const limit = Date.now() + (this.opts.waitForRunsMs ?? Workshop.WAIT_FOR_RUNS_MS);
    const poll = async () => {
      const still = (await store.agentState.all().catch(() => [])).filter((s) => s.status === "working");
      if (!still.length || Date.now() >= limit) start(); else setTimeout(() => void poll(), this.opts.pollMs ?? 15_000);
    };
    setTimeout(() => void poll(), this.opts.pollMs ?? 15_000);
    return `Pushed ${sha.slice(0, 7)} to ${branch}. ${busy.length === 1 ? `${busy[0]} is` : `${busy.join(", ")} are`} mid-run, so the restart waits for that to finish (up to ${Math.round((this.opts.waitForRunsMs ?? Workshop.WAIT_FOR_RUNS_MS) / 60_000)} minutes); then HQ rebuilds and restarts, and rolls back to ${previous.slice(0, 7)} on its own if it doesn't come back up.`;
  }
  static WAIT_FOR_RUNS_MS = 25 * 60_000;

  /** On boot: read the deploy script's verdict for a ship that was in flight, revert the branch if it rolled back. */
  async finish(store: Store): Promise<{ record: ShipRecord; message: string } | undefined> {
    const rec = await store.settings.get<ShipRecord | null>(SHIP_KEY, null);
    if (!rec || rec.status !== "shipping") return undefined;
    const file = this.opts.outcomeFile ?? "/var/lib/jarvis/last-deploy.json";
    let outcome: { at?: string; ok?: boolean; sha?: string; rolledBackTo?: string; error?: string } = {};
    try { outcome = JSON.parse(await fs.readFile(file, "utf8")) as typeof outcome; } catch { /* no verdict file */ }
    const live = await this.must(["rev-parse", "HEAD"], this.opts.appDir).catch(() => "");
    const fresh = outcome.at && rec.at && outcome.at >= rec.at;
    let message: string;
    if (live.startsWith(rec.sha) || (fresh && outcome.ok)) {
      rec.status = "done"; message = `Shipped "${rec.title}" (${rec.sha.slice(0, 7)}): HQ is back up on the new code.`;
    } else if (fresh && outcome.ok === false) {
      rec.status = "rolled-back";
      // Take the bad commit back off the branch so the next deploy doesn't pick it up again.
      let reverted = "";
      try {
        const { branch } = await this.target();
        await this.must(["fetch", "-q", "origin", branch], this.opts.dir, this.auth());
        await this.must(["checkout", "-q", "--detach", `origin/${branch}`]);
        await this.must(["revert", "--no-edit", rec.sha]);
        const r = await this.must(["rev-parse", "HEAD"]);
        await this.must(["push", "-q", "origin", `${r}:refs/heads/${branch}`], this.opts.dir, this.auth());
        reverted = ` The commit is reverted on ${branch}.`;
      } catch (e) { reverted = ` I couldn't revert it on the branch (${(e as Error).message.slice(0, 120)}); the next deploy would try it again, so tell Einstein.`; }
      message = `"${rec.title}" (${rec.sha.slice(0, 7)}) was rolled back: HQ didn't come up on it${outcome.error ? ` (${outcome.error.slice(0, 200)})` : ""}. Running ${(outcome.rolledBackTo ?? rec.previous ?? "").slice(0, 7)} again.${reverted}`;
    } else {
      rec.status = "failed"; message = `"${rec.title}" (${rec.sha.slice(0, 7)}): the deploy didn't report back and HQ is on ${live.slice(0, 7)}. Check journalctl -u jarvis-server and /var/log/jarvis-deploy.log.`;
    }
    rec.note = message;
    await store.settings.set(SHIP_KEY, rec);
    return { record: rec, message };
  }

  /** For Settings: the deploy script's last verdict (any deploy, not only Einstein's) and the commit HQ is running now. */
  async lastDeploy(): Promise<DeployStatus> {
    const file = this.opts.outcomeFile ?? "/var/lib/jarvis/last-deploy.json";
    let last: DeployOutcome | null = null;
    try {
      const o = JSON.parse(await fs.readFile(file, "utf8")) as Partial<DeployOutcome>;
      // The script writes "" for a field it has nothing for.
      if (o.at) last = { at: o.at, ok: o.ok === true, sha: o.sha || undefined, previous: o.previous || undefined, rolledBackTo: o.rolledBackTo || undefined, error: o.error || undefined };
    } catch { /* no deploy recorded yet, or an unreadable file */ }
    const live = await Promise.all([this.must(["rev-parse", "HEAD"], this.opts.appDir), this.must(["rev-parse", "--abbrev-ref", "HEAD"], this.opts.appDir)])
      .then(([sha, branch]) => ({ sha, branch })).catch(() => null);
    return { last, live };
  }
}

/**
 * What Einstein's file and shell tools may touch in the workshop: files inside it only, never .env or keys, never the
 * live app, nothing that reaches the network or the system. Returns the reason to refuse, or nothing to allow.
 */
export function workshopGuard(dir: string, appDir?: string): (tool: string, input: Record<string, unknown>) => string | undefined {
  const root = path.resolve(dir) + path.sep;
  const live = appDir ? path.resolve(appDir) : undefined;
  const inside = (p: string) => path.resolve(dir, p) + (p.endsWith(path.sep) ? "" : "") === path.resolve(dir, p) && (path.resolve(dir, p) + path.sep).startsWith(root);
  const secret = (p: string) => /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx)$|(^|\/)(secrets?|credentials?)(\/|$)/i.test(p);
  const BANNED = /(^|[\s;&|(`])(sudo|su|ssh|scp|sftp|curl|wget|nc|ncat|telnet|psql|pg_dump|systemctl|service|docker|env|printenv|export|chmod|chown|chgrp|kill|pkill|killall|reboot|shutdown|crontab|nohup|screen|tmux|python3?|perl|ruby)\b/;
  return (tool, input) => {
    if (/^(Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|LS)$/.test(tool)) {
      const p = [input.file_path, input.path, input.notebook_path].find((v) => typeof v === "string") as string | undefined;
      if (p === undefined) return undefined;
      if (!inside(p)) return `only files inside the workshop (${dir}) can be opened; ${p} is outside it`;
      if (secret(p)) return `${p} may hold secrets; Einstein's tools never open .env, keys or credential files`;
      if (/(^|\/)\.git\//.test(p) && tool !== "Read" && tool !== "Glob" && tool !== "Grep") return "the .git directory is managed by HQ's git commands, not by edits";
      return undefined;
    }
    if (tool === "Bash") {
      const c = String(input.command ?? "");
      // Prose inside plain quotes (a commit message, an echo) isn't a command; a quoted string that runs something still is.
      const code = c.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => (/\$\(|`|\$\{/.test(q) ? q : '""'));
      if (BANNED.test(code)) return "that command isn't allowed in the workshop (no network, no system tools, no secrets): use pnpm, node, git and ordinary file commands";
      if (/\.env\b|\.(pem|key)\b|\/etc\/|\/proc\/|\/root\b|~\/|\$HOME|\/home\//.test(c)) return "the command names a secret, system or home path; the workshop is the only place these tools work";
      // The live app's path, as a whole path (the workshop may live beside it, e.g. /opt/jarvis-workshop).
      if (live && new RegExp(`${live.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|\\s|$|["'])`).test(c.split(path.resolve(dir)).join(""))) return `the live app at ${live} is off limits; work only in ${dir}`;
      if (/\.\.\//.test(code)) return "no paths above the workshop";
      for (const m of code.matchAll(/(?:^|[\s=:"'])(\/[^\s"':;|&)]+)/g)) {
        const p = m[1]!;
        if (p === "/dev/null" || p.startsWith("/dev/") || p.startsWith("/tmp/")) continue;
        if (!(path.resolve(p) + path.sep).startsWith(root)) return `absolute paths outside the workshop (${p}) aren't allowed`;
      }
      if (/\bgit\s+push\b/.test(c)) return "git push is HQ's job: submit the change with workshop_submit and Phil ships it";
      return undefined;
    }
    return undefined;
  };
}

// ---- Einstein's HQ tools ---------------------------------------------------------------------------------------------

import { z } from "zod";
import { defineTool, type ToolDef } from "./tools/index.js";

/** Lines that look like keys or tokens are masked before a log reaches an agent. */
export const maskSecrets = (s: string) => s.replace(/\b(?:sk|xai|ghp|github_pat|xoxb|AKIA|eyJ)[A-Za-z0-9_.-]{12,}/g, "[masked]").replace(/(token|key|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1$2[masked]").replace(/postgres:\/\/[^:]+:[^@]+@/g, "postgres://[masked]@");

export interface WorkshopToolDeps {
  /** Read-only SQL against HQ's database; HQ supplies it when there is one. */
  query?: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
  /** The server log, last n lines. */
  logs?: (lines: number) => Promise<string>;
}

export const WORKSHOP_HINT = (dir: string, branch: string, base: string) => `You are working in your workshop: ${dir}, a copy of HQ's code on branch ${branch}, started fresh from ${base} (the live branch). Your Read, Edit, Write, Glob, Grep and Bash tools work only inside it; .env, keys and the live app are off limits and git push is refused. The layout: packages/core (the brain: agents, charters, scheduler, tools, connectors), apps/server (API, Telegram, scheduler host), apps/hq (the Next.js screens), deploy/ (server scripts), docs/. Tests: packages/core/tests and apps/server/tests (pnpm test in the package, or node --test --import tsx tests/<name>.test.ts for one file). Read before you change; keep changes small and in the codebase's style; add or adjust a test for behaviour you change.
When the change is ready: call workshop_verify (build, typecheck, tests across packages; fix anything red), then workshop_submit with a title and why. It commits and returns the approval block to put in your reply, word for word, so Phil can ship it from Needs you. HQ then pushes it to the live branch, redeploys, and rolls back by itself if HQ doesn't come back. Never claim a change is live: it is live only after Phil approves and HQ reports the deploy. If a task needs a secret or a setting only Phil can add, say exactly what (name and where) and stop; never guess a key.`;

/** Files that define what Einstein may do; a change to any of them is flagged on the ship card. */
export const GUARDRAIL_FILES = /^(packages\/core\/src\/workshop\.ts|packages\/core\/src\/router\/claude\.ts|packages\/core\/src\/jarvis\/prompts\.ts|packages\/core\/src\/jarvis\/orchestrator\.ts|packages\/core\/src\/trading\/|packages\/core\/src\/registry\/charters\.ts|deploy\/|apps\/server\/src\/auth\.ts|apps\/server\/src\/index\.ts)/;

export function workshopTools(w: Workshop, deps: WorkshopToolDeps = {}): ToolDef[] {
  // The folder is shared, so these three work only for the run that holds the workshop. A run that was told it is busy
  // would otherwise read, test and commit (git add -A) the other run's files as its own.
  const refused = (ctx: { workshopClaim?: string }, what: string) => { const why = w.refusal(ctx?.workshopClaim); return why ? `${what}: ${why}. You can't change code this run; say so and work with the tools you have.` : undefined; };
  return [
    defineTool({
      name: "workshop_status",
      description: "Your workshop: the branch, the files changed so far and the diff.",
      schema: {},
      handler: async (_args, ctx) => { const no = refused(ctx, "Not shown"); if (no) return no; try { const s = await w.status(); return s.files.length ? `Branch ${s.branch}\n${s.stat}\n\n${s.diff}` : `Branch ${s.branch}: no changes yet.`; } catch (e) { return `Workshop isn't ready: ${(e as Error).message}`; } },
    }),
    defineTool({
      name: "workshop_verify",
      description: "Build, typecheck and run the tests of every package in the workshop (a few minutes). Fix what's red before submitting.",
      schema: {},
      handler: async (_args, ctx) => { const no = refused(ctx, "Not run"); if (no) return no; try { const v = await w.verify(); return `${v.ok ? "ALL GREEN" : "RED"}\n${v.report}`; } catch (e) { return `Verify failed to run: ${(e as Error).message}`; } },
    }),
    defineTool({
      name: "workshop_submit",
      description: "Commit the change and get the approval block for Phil. Runs the checks first; a red check returns the failures instead. Put the returned block in your reply exactly.",
      schema: { title: z.string().min(8).max(120).describe("one line, imperative, what the change does"), why: z.string().min(10).max(2000).describe("why, what Phil will notice, and anything he must do (a setting, a key)") },
      handler: async ({ title, why }, ctx) => {
        const no = refused(ctx, "Not submitted");
        if (no) return no;
        try {
          const v = await w.verify();
          if (!v.ok) return `Not submitted: the checks are red. Fix these, then submit again.\n${v.report}`;
          // The checks take minutes; the workshop must still be this run's when the commit is made.
          const lost = refused(ctx, "Not submitted");
          if (lost) return lost;
          const sha = await w.commit(title);
          if (!sha) return "Nothing to submit: the workshop has no changes.";
          const d = await w.describe(sha);
          // A change to the guardrails themselves is still Phil's call, but it must be impossible to miss on the card.
          const rails = d.files.filter((f) => GUARDRAIL_FILES.test(f));
          const body = `${rails.length ? `GUARDRAILS TOUCHED: ${rails.join(", ")}. This change edits the code that limits what Einstein can do (the workshop guard, the deploy script, approvals or safety rules). Read the diff before approving.\n\n` : ""}${why.trim()}\n\nFiles: ${d.files.join(", ")}\n${d.stat}\n\nChecks: all green (build, typecheck, tests).`;
          const block = { kind: "config", title: `${rails.length ? "Ship (touches guardrails)" : "Ship"}: ${title}`, body, payload: { action: "code.ship", sha, title, files: d.files, guardrails: rails }, context: `Einstein changed ${d.files.length} file${d.files.length === 1 ? "" : "s"} in the workshop on branch ${w.current?.branch ?? "einstein"}; every check passed. Approving pushes commit ${sha.slice(0, 7)} to the live branch and redeploys HQ (two or three minutes, HQ restarts); if HQ doesn't come back it rolls back on its own.` };
          return `Committed ${sha.slice(0, 7)}. Put this in your reply, exactly:\n\n\`\`\`approval\n${JSON.stringify(block)}\n\`\`\``;
        } catch (e) { return `Submit failed: ${(e as Error).message}`; }
      },
    }),
    defineTool({
      name: "hq_logs",
      description: "The live HQ server log, newest last (secrets masked). For diagnosing errors, timeouts and failed runs.",
      schema: { lines: z.number().int().min(20).max(400).optional().describe("how many lines, default 150") },
      handler: async ({ lines }) => { if (!deps.logs) return "The server log isn't available from here."; try { return maskSecrets(await deps.logs(lines ?? 150)); } catch (e) { return `Couldn't read the log: ${(e as Error).message}`; } },
    }),
    defineTool({
      name: "db_query",
      description: "Run one read-only SQL query against HQ's Postgres (tables: chat_messages, runs, activity, approvals, memory, usage, agent_state, settings, records, metrics, attention). SELECT/WITH/EXPLAIN only, up to 200 rows.",
      schema: { sql: z.string().min(6).max(4000) },
      handler: async ({ sql }) => {
        if (!deps.query) return "There is no database to query here (JSON store).";
        const q = sql.trim().replace(/;\s*$/, "");
        if (!/^(select|with|explain)\b/i.test(q) || /;/.test(q) || /\b(insert|update|delete|drop|alter|create|truncate|grant|copy)\b/i.test(q)) return "Read-only: one SELECT, WITH or EXPLAIN statement, no writes.";
        try {
          const { rows } = await deps.query(q);
          const shown = rows.slice(0, 200);
          if (!shown.length) return "No rows.";
          const cols = Object.keys(shown[0]!);
          return maskSecrets([cols.join(" | "), ...shown.map((r) => cols.map((c) => String(r[c] ?? "").replace(/\s+/g, " ").slice(0, 200)).join(" | "))].join("\n") + (rows.length > 200 ? `\n(${rows.length} rows; first 200 shown)` : ""));
        } catch (e) { return `Query failed: ${(e as Error).message.slice(0, 300)}`; }
      },
    }),
  ];
}

/** A read-only SQL runner on HQ's Postgres for db_query: every query runs in a read-only transaction. */
export function readOnlyQuery(url: string): WorkshopToolDeps["query"] {
  let db: import("./db/client.js").Db | undefined;
  return async (q: string) => {
    const { createDb } = await import("./db/client.js");
    const { sql } = await import("drizzle-orm");
    db ??= createDb(url);
    return db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const r = await tx.execute(sql.raw(q));
      return { rows: (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[] };
    });
  };
}
