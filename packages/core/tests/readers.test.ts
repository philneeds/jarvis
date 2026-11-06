import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, DiscordConnector, GithubConnector, parseChannels, CHARTERS, SCHEDULES } from "../src/index.js";

test("Discord: a bot reads recent channel messages (oldest first, filtered by word), nothing is posted", async () => {
  const store = memoryStore(); await store.init();
  const now = Date.parse("2026-11-06T15:00:00Z");
  const calls: { path: string; auth: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const h = init?.headers as Record<string, string>;
    calls.push({ path: u.pathname + u.search, auth: h.authorization });
    if (h.authorization !== "Bot tok") return new Response(JSON.stringify({ message: "401: Unauthorized" }), { status: 401 });
    if (u.pathname === "/api/v10/users/@me") return Response.json({ username: "jarvis-reader" });
    if (u.pathname === "/api/v10/channels/111") return Response.json({ name: "biotech-alpha" });
    if (u.pathname === "/api/v10/channels/111/messages") return Response.json([
      { id: "3", content: "VKTX readout tomorrow, I'm sized small", timestamp: "2026-11-06T14:30:00Z", author: { username: "jen", global_name: "Jen" } },
      { id: "2", content: "", timestamp: "2026-11-06T12:00:00Z", author: { username: "newsbot", bot: true }, embeds: [{ title: "FDA accepts NDA", url: "https://example.com/fda", description: "Viking Therapeutics said…" }] },
      { id: "1", content: "old", timestamp: "2026-11-04T10:00:00Z", author: { username: "bob" } },
    ]);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  assert.deepEqual(parseChannels("biotech=111111111111111111, 222222222222222222, nope=12"), [{ label: "biotech", id: "111111111111111111" }, { label: "222222222222222222", id: "222222222222222222" }]);
  const d = new DiscordConnector(store, { token: "tok", channels: [{ label: "biotech", id: "111" }], fetch: f, now: () => now });
  assert.equal(await d.check(), "Bot jarvis-reader is in. Channels: biotech (#biotech-alpha).");
  const t = d.tools()[0]!;
  const out = await t.handler({ hours: 24 }, { store, agentId: "house" });
  assert.match(out, /#biotech · 2 messages in the last 24h/);
  assert.match(out, /Nov 6, 7:00 AM · newsbot: \[FDA accepts NDA https:\/\/example.com\/fda\] Viking Therapeutics said…\nNov 6, 9:30 AM · Jen: VKTX readout tomorrow/);
  assert.doesNotMatch(out, /\bold\b/, "messages older than the window are left out");
  assert.match(await t.handler({ word: "vktx" }, { store, agentId: "house" }), /1 message in the last 24h about "vktx"/);
  assert.ok(calls.every((c) => !/POST/.test(c.path)));
  assert.deepEqual(Object.keys(d.executors()), []);
  assert.match(await new DiscordConnector(store, { token: "bad", channels: [{ label: "biotech", id: "111" }], fetch: f }).tools()[0]!.handler({}, { store, agentId: "house" }), /refused the bot token/);
  assert.ok(CHARTERS.house!.tools!.includes("discord_recent"));
  assert.match(SCHEDULES.find((s) => s.id === "house-open")!.task, /discord_recent/);
});

test("GitHub: read-only repos, tree, file, commits and issues, limited to the repos Phil shared", async () => {
  const store = memoryStore(); await store.init();
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const h = init?.headers as Record<string, string>;
    if (h.authorization !== "Bearer ghp") return new Response("{}", { status: 401 });
    if (u.pathname === "/user") return Response.json({ login: "philneeds" });
    if (u.pathname === "/repos/range/app") return Response.json({ full_name: "range/app", private: true, default_branch: "main", language: "TypeScript", pushed_at: "2026-11-05T00:00:00Z", open_issues_count: 3, description: "Range.cool app" });
    if (u.pathname === "/repos/range/app/git/trees/main") return Response.json({ tree: [{ path: "src", type: "tree" }, { path: "src/index.ts", type: "blob", size: 120 }, { path: "README.md", type: "blob", size: 40 }] });
    if (u.pathname === "/repos/range/app/contents/src/index.ts") return new Response("export const x = 1;\n");
    if (u.pathname === "/repos/range/app/commits") return Response.json([{ sha: "abcdef1234", commit: { message: "Fix login\n\nmore", author: { name: "Jason", date: "2026-11-05T12:00:00Z" } }, author: { login: "jason" } }]);
    if (u.pathname === "/repos/range/app/issues") return Response.json([{ number: 7, title: "Wallet connect fails on mobile", state: "open", user: { login: "phil" }, updated_at: "2026-11-04T00:00:00Z", labels: [{ name: "bug" }] }, { number: 8, title: "Add perps page", state: "open", pull_request: {}, user: { login: "jason" }, updated_at: "2026-11-05T00:00:00Z" }]);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const g = new GithubConnector(store, { token: "ghp", repos: ["range/app"], fetch: f });
  assert.equal(await g.check(), "Token for philneeds reads 1 repo: range/app.");
  const t = (n: string) => g.tools().find((x) => x.name === n)!;
  const ctx = { store, agentId: "jason" };
  assert.match(await t("github_repos").handler({}, ctx), /^range\/app \(private\) · TypeScript · pushed Nov 4, 2026 · 3 open issues\n  Range.cool app$/);
  assert.match(await t("github_tree").handler({ repo: "range/app", path: "src" }, ctx), /2 entries:\nd src\n  src\/index.ts \(120 B\)/);
  assert.equal(await t("github_file").handler({ repo: "range/app", path: "src/index.ts" }, ctx), "export const x = 1;\n");
  assert.match(await t("github_commits").handler({ repo: "range/app" }, ctx), /^abcdef1 · jason · Nov 5, 2026 · Fix login$/);
  assert.match(await t("github_issues").handler({ repo: "range/app" }, ctx), /#7 issue · open · phil · Nov 3, 2026 · Wallet connect fails on mobile \[bug\]\n#8 PR · open · jason/);
  assert.match(await t("github_file").handler({ repo: "other/secret", path: "x" }, ctx), /isn't one of the repos Phil shared \(range\/app\)/);
  assert.deepEqual(Object.keys(g.executors()), []);
  for (const id of ["jason", "paul", "ansem", "devteam"]) assert.ok(CHARTERS[id]!.tools!.includes("github_file"), `${id} reads code`);
});
