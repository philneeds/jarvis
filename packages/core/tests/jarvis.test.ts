import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, getAgent, bus, Scheduler, type JarvisEvent } from "../src/index.js";

function make() {
  const store = memoryStore();
  const router = new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } });
  return { store, jarvis: new Jarvis({ store, router }) };
}

test("Phil asks Jarvis, gets an answer from a Claude agent and a Grok agent (Phase 0 gate)", async () => {
  const { jarvis, store } = make();
  await store.init();
  const out = await jarvis.handle("Status from @stella and @lucas please");
  const final = out[out.length - 1]!;
  assert.equal(final.role, "jarvis");
  assert.deepEqual(final.via, ["stella", "lucas"]);
  const runs = (await store.activity.list({ limit: 50 })).filter((e) => e.kind === "run");
  assert.ok(runs.some((r) => r.summary.startsWith("Stella ran") && r.summary.includes("mock-claude")));
  assert.ok(runs.some((r) => r.summary.startsWith("Lucas ran") && r.summary.includes("mock-grok")));
  const usage = await store.usage.since(new Date(0));
  assert.ok(usage.some((u) => u.plan === "claude") && usage.some((u) => u.plan === "supergrok"));
});

test("@agent talks to the agent directly", async () => {
  const { jarvis } = make();
  const out = await jarvis.handle("@munger how's the week?");
  assert.equal(out[0]!.role, "agent");
  assert.equal(out[0]!.agentId, "munger");
  assert.match(out[0]!.text, /Charlie Munger here/);
});

test("kill switch and pause block runs", async () => {
  const { jarvis, store } = make();
  await jarvis.pause("all", true);
  let r = await jarvis.runAgent(getAgent("stella")!, "hi", { direct: true });
  assert.match(r.blocked!, /kill switch/);
  await jarvis.pause("all", false);
  await jarvis.pause("trading", true);
  r = await jarvis.runAgent(getAgent("mayne")!, "trade", { direct: true });
  assert.match(r.blocked!, /trading is paused/);
  r = await jarvis.runAgent(getAgent("stella")!, "hi", { direct: true });
  assert.equal(r.blocked, undefined);
  await jarvis.pause("@stella", true);
  r = await jarvis.runAgent(getAgent("stella")!, "hi", { direct: true });
  assert.match(r.blocked!, /paused/);
  const s = await store.settings.get("killSwitch", { agents: [] as string[] });
  assert.deepEqual(s.agents, ["stella"]);
});

test("agents on manual models (Cursor, ChatGPT Health) are reported, not run", async () => {
  const { jarvis } = make();
  const r = await jarvis.runAgent(getAgent("jason2")!, "review", { direct: true });
  assert.match(r.blocked!, /Cursor/);
});

test("approvals queue, decide, and emit events", async () => {
  const { jarvis, store } = make();
  const events: JarvisEvent[] = [];
  const off = bus.onEvent((e) => events.push(e));
  const a = await jarvis.requestApproval({ agentId: "stephanie", kind: "send", title: "Reply to a customer", body: "Send the drafted reply" });
  assert.equal((await store.approvals.list("pending")).length, 1);
  assert.equal((await store.agentState.get("stephanie"))?.status, "waiting");
  const d = await jarvis.decide(a.id, "approved", "looks good");
  assert.equal(d?.status, "approved");
  assert.equal((await store.agentState.get("stephanie"))?.status, "idle");
  assert.ok(events.some((e) => e.type === "approval.new") && events.some((e) => e.type === "approval.decided"));
  off();
});

test("commands: /status, /help, /approvals, /usage", async () => {
  const { jarvis } = make();
  assert.match(await jarvis.command("/help"), /\/brief/);
  assert.match(await jarvis.command("/status"), /Status GREEN/);
  assert.match(await jarvis.command("/approvals"), /Nothing waiting/);
  assert.match(await jarvis.command("/usage"), /Claude/);
  assert.match(await jarvis.command("/bogus"), /Unknown command/);
});

test("scheduler respects phase and daily windows", () => {
  const { jarvis } = make();
  const s = new Scheduler(jarvis, [
    { id: "a", agentId: "jarvis", task: "brief", when: "daily@07:00", phase: 0 },
    { id: "b", agentId: "ansem", task: "scan", when: "every:60", phase: 2 },
  ]);
  const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  assert.deepEqual(s.due(at(6, 59), 0).map((x) => x.id), []);
  assert.deepEqual(s.due(at(7, 3), 0).map((x) => x.id), ["a"]);
  assert.deepEqual(s.due(at(7, 3), 2).map((x) => x.id), ["a", "b"]);
  assert.deepEqual(s.due(at(7, 30), 0).map((x) => x.id), []);
});

test("duplicate delegations collapse to one run per agent", async () => {
  const { jarvis, store } = make();
  await jarvis.handle("Status from @stella and @stella and @Stella please");
  const runs = (await store.activity.list({ limit: 50 })).filter((e) => e.kind === "run" && e.summary.startsWith("Stella ran"));
  assert.equal(runs.length, 1);
});
