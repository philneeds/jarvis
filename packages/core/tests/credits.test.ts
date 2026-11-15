import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, Scheduler, memoryStore, mockProvider, getAgent, type MemoryItem } from "../src/index.js";
import { memoryBrief, agentSystemPrompt } from "../src/jarvis/prompts.js";

/** Spending fewer credits without losing context: quiet routines, shorter briefings, one call instead of three. */
function make() {
  const store = memoryStore();
  const provider = mockProvider("mock");
  const calls: { agent: string; prompt: string; system: string }[] = [];
  const base = provider.run.bind(provider);
  provider.run = async (req) => { calls.push({ agent: req.agent.id, prompt: req.prompt, system: req.system ?? "" }); return base(req); };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  return { store, jarvis, calls };
}
const note = (scope: string, key: string, value: string): MemoryItem => ({ scope, key, value, source: "phil", updatedAt: "2026-11-01T00:00:00Z" });

test("a briefing keeps long notes short, the agent's own notes whole, and never drops one silently", () => {
  const long = "Phil writes short, lower-case, punchy posts. ".repeat(60); // about 2,700 characters
  const items = [note("phil", "likes", "short answers"), note("phil", "voice-notes", long), note("agent:boo", "skill:hooks", long), note("agent:boo", "handoff:lucas", long)];
  const text = memoryBrief(items, { own: (m) => m.scope === "agent:boo" });
  const lines = text.split("\n");
  assert.match(lines[0]!, /^- \[agent:boo\] handoff:lucas: /, "what was handed to the agent comes first");
  assert.equal(lines[0]!.length > 2700, true, "and is never cut: it is acted on once and removed");
  assert.match(lines[1]!, /^- \[agent:boo\] skill:hooks: /);
  assert.doesNotMatch(lines[1]!, /more characters/, "its own playbook fits whole");
  const cut = lines.find((l) => l.startsWith("- [phil] voice-notes"))!;
  assert.ok(cut.length < 700, "someone else's long note is kept to a few lines");
  assert.match(cut, /… \(\d+ more characters: memory_read with this scope and key for the rest\)$/);
  assert.ok(lines.some((l) => l === "- [phil] likes: short answers"), "a short note is untouched");
  // Past the budget: listed by title, not dropped.
  const many = Array.from({ length: 80 }, (_, i) => note("phil", `fact-${i}`, "x".repeat(400)));
  const big = memoryBrief(many, { budget: 5000 });
  assert.match(big, /Also on file, titles only \(memory_read with this scope and key for the text\): .*\[phil\] fact-79/);
  assert.ok(big.length < 8000);
  assert.equal(memoryBrief([]), "(nothing on file yet)");
  // In an agent's own briefing, a note its charter names counts as its own.
  const boo = getAgent("boo")!;
  const sys = agentSystemPrompt(boo, [note("phil", "voice-guide", long)], {}, []);
  assert.doesNotMatch(sys.split("What the web knows:")[1]!, /more characters/, "Boo's voice guide is named in his charter, so he gets all of it");
});

test("every agent can read a full note, and the briefing it runs with is bounded", async () => {
  const { jarvis, store, calls } = make();
  const long = "A very long note about ProEdge scheduling. ".repeat(80);
  await store.memory.set({ scope: "phil", key: "proedge-notes", value: long, source: "phil" });
  const read = jarvis.allTools().find((t) => t.name === "memory_read")!;
  assert.equal(await read.handler({ scope: "phil", key: "proedge-notes" }, { store, agentId: "bill" }), `[phil] proedge-notes: ${long}`);
  assert.match(await read.handler({ scope: "phil", key: "nope" }, { store, agentId: "bill" }), /No note with that scope and key/);
  await jarvis.runAgent(getAgent("bill")!, "What's on today?", { direct: true });
  const run = calls.find((c) => c.agent === "bill")!;
  assert.match(run.system, /memory_read/, "the tool is in Bill's list although his charter doesn't name it");
  assert.match(run.system, /\[phil\] proedge-notes: .{300,600} … \(\d+ more characters/s);
  assert.equal(run.system.includes(long), false, "the long note isn't sent whole");
});

test("a routine that watches its sources runs only when they hold something new", async () => {
  const { jarvis } = make();
  let ghl = "c1,c2", mailFails = false;
  jarvis.pulses.set("ghl", async () => ghl);
  jarvis.pulses.set("mail", async () => { if (mailFails) throw new Error("Gmail is down"); return "m1,m2"; });
  // First look: nothing to compare with, so it runs.
  let q = await jarvis.quiet("schedule:karol-leads", "karol", ["ghl", "mail"]);
  assert.equal(q.skip, undefined);
  // The run failed, so nothing is recorded: the next look still runs.
  assert.equal((await jarvis.quiet("schedule:karol-leads", "karol", ["ghl", "mail"])).skip, undefined);
  await q.ran();
  // Same contacts, same mail: skipped, with a reason in plain words.
  q = await jarvis.quiet("schedule:karol-leads", "karol", ["ghl", "mail"]);
  assert.match(q.skip ?? "", /^nothing new in GoHighLevel or mail since /);
  // A new lead: it runs.
  ghl = "c1,c2,c3";
  q = await jarvis.quiet("schedule:karol-leads", "karol", ["ghl", "mail"]);
  assert.equal(q.skip, undefined);
  await q.ran();
  assert.ok((await jarvis.quiet("schedule:karol-leads", "karol", ["ghl", "mail"])).skip);
  // A source that can't be read is never a reason to skip.
  mailFails = true;
  assert.equal((await jarvis.quiet("schedule:karol-leads", "karol", ["ghl", "mail"])).skip, undefined);
  mailFails = false;
  // A week of quiet and it runs anyway.
  const old = Jarvis.MAX_QUIET_MS;
  Jarvis.MAX_QUIET_MS = 0;
  try { assert.equal((await jarvis.quiet("schedule:karol-leads", "karol", ["ghl", "mail"])).skip, undefined); } finally { Jarvis.MAX_QUIET_MS = old; }
  // A source nobody connected is constant: asked once, then left alone until it's connected.
  const d = await jarvis.quiet("brief:doc", "doc", ["calendar-of-nothing"]);
  assert.equal(d.skip, undefined);
  await d.ran();
  assert.match((await jarvis.quiet("brief:doc", "doc", ["calendar-of-nothing"])).skip ?? "", /nothing new/);
});

test("on its timer the lead check doesn't call the model twice for the same inbox; a run Phil asks for always runs", async () => {
  const { jarvis, store, calls } = make();
  await store.settings.set("phase", 1);
  let leads = "c1";
  jarvis.pulses.set("ghl", async () => leads);
  jarvis.pulses.set("mail", async () => "m1");
  const routine = { id: "karol-leads", agentId: "karol", watch: ["ghl", "mail"], task: "Morning lead check.", when: "daily@07:15", phase: 1 };
  const runs = () => calls.filter((c) => c.agent === "karol").length;
  const at = (day: number) => new Date(2026, 10, day, 7, 16);
  const s = new Scheduler(jarvis, [routine]);
  await s.tick(at(16));
  assert.equal(runs(), 1, "first morning: it runs");
  await s.tick(at(17));
  assert.equal(runs(), 1, "second morning, nothing new: no model call");
  assert.ok((await store.activity.list({ limit: 20 })).some((e) => /Scheduled: karol-leads · skipped, nothing new in GoHighLevel or mail/.test(e.summary)));
  leads = "c1,c2";
  await s.tick(at(18));
  assert.equal(runs(), 2, "a new lead: it runs");
  // Phil pressing Run now isn't gated.
  const { runRoutine } = await import("../src/scheduler.js");
  await runRoutine(jarvis, routine, { direct: true });
  assert.equal(runs(), 3);
});

test("memory isn't tidied again when nothing was remembered since the last tidy", async () => {
  const { jarvis, store, calls } = make();
  for (let i = 0; i < 24; i++) await store.memory.set({ scope: "phil", key: `k${i}`, value: `v${i}`, source: "phil" });
  const s = new Scheduler(jarvis, [{ id: "oscar-condense", agentId: "oscar", task: "condense", when: "daily@03:30", phase: 0 }]);
  const tidies = () => calls.filter((c) => c.agent === "oscar").length;
  await s.tick(new Date(2026, 10, 16, 3, 31));
  assert.equal(tidies(), 1);
  await s.tick(new Date(2026, 10, 17, 3, 31));
  assert.equal(tidies(), 1, "memory is as the last tidy left it");
  for (let i = 0; i < 12; i++) await store.memory.set({ scope: "phil", key: `new${i}`, value: "something new", source: "phil" });
  await s.tick(new Date(2026, 10, 18, 3, 31));
  assert.equal(tidies(), 2, "new notes: it tidies");
});

test("Doc isn't asked for the morning brief when there's no new health data", async () => {
  const { jarvis, store, calls } = make();
  await store.settings.set("phase", 1);
  await store.agentState.set("doc", { status: "idle", lastRunAt: new Date().toISOString() });
  process.env.BRIEF_WAIT_STEP_MS = "1";
  const asked = () => calls.filter((c) => c.agent === "doc").length;
  await jarvis.brief();
  assert.equal(asked(), 1, "the first brief asks him");
  await jarvis.brief();
  assert.equal(asked(), 1, "no health data then, none now: not asked again");
  assert.ok((await store.activity.list({ limit: 30 })).some((e) => /wasn't asked for the brief: nothing new in health data/.test(e.summary)));
});

test("one agent asked: its answer goes to Phil as written, with no second Jarvis call; two agents are still put together", async () => {
  const { jarvis, calls } = make();
  const one = await jarvis.handle("Status from @stella please");
  const final = one[one.length - 1]!;
  assert.equal(final.kind, "final");
  assert.equal(final.role, "agent");
  assert.equal(final.agentId, "stella");
  assert.deepEqual(final.via, ["jarvis"]);
  assert.equal(calls.filter((c) => c.agent === "jarvis").length, 1, "Jarvis planned, and didn't rewrite");
  assert.match(calls.find((c) => c.agent === "stella")!.prompt, /^Phil \(through Jarvis; your answer goes to him as written\) asks: /);
  calls.length = 0;
  const two = await jarvis.handle("Status from @stella and @karol please");
  const last = two[two.length - 1]!;
  assert.equal(last.role, "jarvis");
  assert.deepEqual(last.via?.sort(), ["karol", "stella"]);
  assert.equal(calls.filter((c) => c.agent === "jarvis").length, 2, "plan, then one answer from both reports");
});
