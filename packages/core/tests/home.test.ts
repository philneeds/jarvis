import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addressee, isActive, nowStrip, oneLine, pickerGroups, readdress, type HomeAgent } from "../src/home.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const agent = (id: string, p: Partial<HomeAgent> = {}): HomeAgent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), layer: 2, venture: "command", live: true, status: "idle", ...p });

test("home.ts stays import-free so HQ's browser code can load it", () => {
  const src = readFileSync(new URL("../src/home.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s(?!type\b)/m.test(src), false);
});

test("active means live and ran in the last seven days, or busy right now", () => {
  assert.equal(isActive(agent("a", { lastRunAt: ago(2) }), NOW), true);
  assert.equal(isActive(agent("b", { lastRunAt: ago(8) }), NOW), false);
  assert.equal(isActive(agent("c"), NOW), false);
  assert.equal(isActive(agent("d", { status: "working" }), NOW), true);
  assert.equal(isActive(agent("e", { lastRunAt: ago(1), live: false }), NOW), false);
});

test("the picker lists leads first, then the team, active agents only, never Jarvis", () => {
  const groups = pickerGroups([
    agent("jarvis", { layer: 0, lastRunAt: ago(0) }),
    agent("stella", { layer: 1, lastRunAt: ago(1) }),
    agent("munger", { layer: 1, lastRunAt: ago(3) }),
    agent("stevon", { layer: 1, lastRunAt: ago(30) }),
    agent("monica", { layer: 2, lastRunAt: ago(0) }),
    agent("ghost", { layer: 3, live: false, lastRunAt: ago(0) }),
  ], NOW);
  assert.deepEqual(groups.map((g) => [g.label, g.agents.map((a) => a.id)]), [["Leads", ["munger", "stella"]], ["Team", ["monica"]]]);
});

test("the command line's addressee and readdressing", () => {
  assert.equal(addressee("@Stella what's new"), "stella");
  assert.equal(addressee("what's new"), "jarvis");
  assert.equal(readdress("what's new", "stella"), "@stella what's new");
  assert.equal(readdress("@munger what's new", "stella"), "@stella what's new");
  assert.equal(readdress("@munger what's new", "jarvis"), "what's new");
  assert.equal(readdress("", "doc"), "@doc ");
});

test("oneLine keeps the first real line, without markdown, cut at a word", () => {
  assert.equal(oneLine("## Done\n\n- **Queued** the card"), "Queued the card");
  assert.equal(oneLine("## Only a heading"), "Only a heading");
  assert.equal(oneLine("---\n`Sent` the [brief](http://x)"), "Sent the brief");
  const long = oneLine("word ".repeat(60), 30);
  assert.ok(long.endsWith("…") && long.length <= 31);
});

test("Now: working, waiting grouped per agent, last three finished runs one per run", () => {
  const agents = [
    agent("monica", { status: "working", detail: "Reading Nov 15-22 on pmarino@getproedge.com" }),
    agent("stella", { layer: 1 }),
    agent("doc", { status: "waiting", detail: "Needs your sleep data" }),
    agent("einstein"),
  ];
  const s = nowStrip({
    agents,
    pending: [
      { id: "p1", agentId: "stella", title: "Send the Tracy quote", at: "2026-11-14T10:00:00Z" },
      { id: "p2", agentId: "stella", title: "Post the JD PM reel", at: "2026-11-14T11:00:00Z" },
    ],
    attention: [{ id: "t1", agentId: "einstein", title: "Add GROQ_API_KEY", status: "open", at: "2026-11-14T09:00:00Z" }, { id: "t2", agentId: "einstein", title: "Old", status: "done", at: "2026-11-14T11:30:00Z" }],
    activity: [
      { id: "a1", at: "2026-11-14T11:59:00Z", agentId: "monica", kind: "run", runId: "r1", summary: "Monica ran on opus (claude) in 3.0s", detail: { output: "## Calendar\nThree blocks queued." } },
      { id: "a2", at: "2026-11-14T11:58:00Z", agentId: "jarvis", kind: "run", runId: "r1", summary: "Jarvis → Monica (handoff): x" },
      { id: "a3", at: "2026-11-14T11:50:00Z", agentId: "stella", kind: "approval", summary: "Stella asked" },
      { id: "a4", at: "2026-11-14T11:40:00Z", agentId: "stella", kind: "run", runId: "r2", summary: "Stella ran on opus (claude) in 2.0s" },
      { id: "a5", at: "2026-11-14T11:30:00Z", agentId: "einstein", kind: "run", runId: "r3", summary: "Einstein → Jarvis (weekly): Review sent", detail: { report: "Weekly review: 3 ideas moved." } },
      { id: "a6", at: "2026-11-14T11:00:00Z", agentId: "doc", kind: "run", runId: "r4", summary: "Doc ran on opus (claude) in 1.0s" },
    ],
  });
  assert.deepEqual(s.working.map((w) => [w.name, w.line]), [["Monica", "Reading Nov 15-22 on pmarino@getproedge.com"]]);
  assert.deepEqual(s.waiting.map((w) => [w.agentId, w.line, w.count, w.href]), [
    ["stella", "Post the JD PM reel", 2, "/attention#approve"],
    ["einstein", "Add GROQ_API_KEY", undefined, "/attention#todo"],
    ["doc", "Needs your sleep data", undefined, "/attention#todo"],
  ]);
  assert.deepEqual(s.finished.map((f) => [f.agentId, f.line]), [["monica", "Three blocks queued."], ["stella", "Finished a run."], ["einstein", "Weekly review: 3 ideas moved."]]);
});

test("Now is empty when nothing is happening", () => {
  assert.deepEqual(nowStrip({ agents: [agent("a")], pending: [], attention: [], activity: [] }), { working: [], waiting: [], finished: [] });
});
