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
  assert.equal(out[0]!.kind, "ack");
  assert.match(out[0]!.text, /Charlie Munger is on it/);
  assert.equal(out[1]!.role, "agent");
  assert.equal(out[1]!.agentId, "munger");
  assert.match(out[1]!.text, /Charlie Munger here/);
  assert.equal(out[1]!.kind, "final");
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
  // A zero or malformed interval never fires (every:0 would otherwise run on every tick).
  const bad = new Scheduler(jarvis, [
    { id: "z", agentId: "ansem", task: "scan", when: "every:0", phase: 0 },
    { id: "n", agentId: "ansem", task: "scan", when: "every:abc", phase: 0 },
  ]);
  assert.deepEqual(bad.due(at(7, 3), 2), []);
});

test("duplicate delegations collapse to one run per agent", async () => {
  const { jarvis, store } = make();
  await jarvis.handle("Status from @stella and @stella and @Stella please");
  const runs = (await store.activity.list({ limit: 50 })).filter((e) => e.kind === "run" && e.summary.startsWith("Stella ran"));
  assert.equal(runs.length, 1);
});

test("persona, tools and rules from agent settings shape the run", async () => {
  const { jarvis, store } = make();
  const { setAgentConfig, TOOLS } = await import("../src/index.js");
  await setAgentConfig(store, "stephanie", { persona: { job: "Keep every customer answered within the hour." }, tools: ["memory_search"], rules: { autoApprove: ["record"], maxAutoDollars: 500 } });
  // A record change under the cap goes through on its own; a send still waits.
  const auto = await jarvis.requestApproval({ agentId: "stephanie", kind: "record", title: "Update the Smith job date", body: "", payload: { amount: 120 } });
  assert.equal(auto.status, "approved");
  const over = await jarvis.requestApproval({ agentId: "stephanie", kind: "record", title: "Refund", body: "", payload: { amount: 900 } });
  assert.equal(over.status, "pending");
  const send = await jarvis.requestApproval({ agentId: "stephanie", kind: "send", title: "Email", body: "" });
  assert.equal(send.status, "pending");
  assert.ok(TOOLS.some((t) => t.name === "memory_search"));
  const r = await jarvis.runAgent(await import("../src/index.js").then((m) => m.getAgent("stephanie")!), "hi", { direct: true });
  assert.equal(r.blocked, undefined);
});

test("tools answer from the store", async () => {
  const { store } = make();
  const { TOOLS } = await import("../src/index.js");
  await store.memory.set({ scope: "venture:jdpm", key: "smith", value: "wants oak cabinets" });
  const t = TOOLS.find((x) => x.name === "memory_search")!;
  assert.match(await t.handler({ query: "oak" }, { store, agentId: "stella" }), /oak cabinets/);
  const s = TOOLS.find((x) => x.name === "web_status")!;
  assert.match(await s.handler({}, { store, agentId: "stella" }), /Everyone idle/);
});

test("Oscar condenses memory through an approval that executes on approve", async () => {
  const { jarvis, store } = make();
  for (let i = 0; i < 6; i++) await store.memory.set({ scope: "phil", key: `k${i}`, value: `v${i}` });
  const msg = await jarvis.condenseMemory();
  assert.match(msg, /waiting in Approvals/);
  const pending = await store.approvals.list("pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.payload?.action, "memory.replace");
  await jarvis.decide(pending[0]!.id, "approved");
  assert.equal((await store.memory.list()).length, 3);
});

test("custom per-agent schedules merge with the built-in ones", async () => {
  const { jarvis, store } = make();
  const { setAgentConfig } = await import("../src/index.js");
  await setAgentConfig(store, "karol", { schedule: { enabled: true, when: "every:30", task: "Scan for leads" } });
  const s = new Scheduler(jarvis, []);
  const all = await s.allSchedules();
  assert.deepEqual(all.map((x) => x.id), ["custom:karol"]);
  assert.equal(s.due(new Date(), 0, all).length, 1);
});

test("an approval nothing can act on says so when approved", async () => {
  const { jarvis, store } = make();
  const a = await jarvis.requestApproval({ agentId: "stephanie", kind: "send", title: "Email Dana", body: "the draft" });
  const d = await jarvis.decide(a.id, "approved");
  assert.match(d!.note!, /nothing was sent or changed/);
  const chat = await store.chat.list();
  assert.match(chat[chat.length - 1]!.text, /Do it by hand/);
  const b = await jarvis.requestApproval({ agentId: "stephanie", kind: "send", title: "Email Dana", body: "", payload: { action: "gmail.send", to: "dana@x.com" } });
  const e = await jarvis.decide(b.id, "approved");
  assert.match(e!.note!, /No connector handles "gmail.send" yet/);
});

test("a hand-off runs the right agent and posts its reply", async () => {
  const { jarvis, store } = make();
  const { mockProvider: mp, ModelRouter: MR, Jarvis: J } = await import("../src/index.js");
  // A provider that makes Monica hand a lead to Stella.
  const handing = mp("m");
  const base = handing.run.bind(handing);
  handing.run = async (req) => { const r = await base(req); if (req.agent.id === "monica") r.text += '\n\n```handoff\n{"agent":"stella","task":"A kitchen lead from Dana Smith came in by email; follow up."}\n```'; return r; };
  const j2 = new J({ store, router: new MR({ store, providers: { claude: [handing], grok: [mp("g")] } }) });
  const out = await j2.handle("@monica anything in my mail?");
  assert.ok(out[1]!.text.includes("[Handed to @stella]"));
  const chat = await store.chat.list();
  assert.ok(chat.some((m) => m.role === "agent" && m.agentId === "stella" && m.via?.includes("monica")));
  const log = await store.activity.list({ agentId: "monica" });
  assert.ok(log.some((e) => e.kind === "delegate" && /Monica → Stella/.test(e.summary)));
  void jarvis;
});

test("bulk actions over the item cap wait for Phil even when the kind is auto-approved", async () => {
  const { jarvis, store } = make();
  const { setAgentConfig } = await import("../src/index.js");
  await setAgentConfig(store, "monica", { rules: { autoApprove: ["record"], maxAutoDollars: 0, maxAutoItems: 100 } });
  const small = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Archive 40", body: "", payload: { action: "x.y", max: 40 } });
  assert.equal(small.status, "approved");
  const big = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Archive 500", body: "", payload: { action: "x.y", max: 500 } });
  assert.equal(big.status, "pending");
  const ids = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Archive ids", body: "", payload: { action: "x.y", ids: new Array(150).fill("m") } });
  assert.equal(ids.status, "pending");
});

test("attention items: raised from a reply, deduped, snoozed, done, and in Jarvis's prompt", async () => {
  const { jarvis, store } = make();
  const { mockProvider: mp, ModelRouter: MR, Jarvis: J, extractBlocks } = await import("../src/index.js");
  const flag = mp("m"); const base = flag.run.bind(flag);
  flag.run = async (req) => { const r = await base(req); if (req.agent.id === "monica") r.text += '\n\n```attention\n{"title":"Change your Chainstack password","why":"Breach notice on Nov 3.","due":"2026-11-05"}\n```'; return r; };
  const j2 = new J({ store, router: new MR({ store, providers: { claude: [flag], grok: [mp("g")] } }) });
  const out = await j2.handle("@monica anything important?");
  assert.match(out[1]!.text, /\[Needs you: Change your Chainstack password\]/);
  let items = await j2.attention();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.due, "2026-11-05");
  await j2.handle("@monica anything important?"); // same title again: no duplicate
  assert.equal((await j2.attention()).length, 1);
  assert.match(await j2.attentionText(), /Chainstack/);
  await j2.attentionUpdate(items[0]!.id, "snoozed", 2);
  assert.equal((await j2.attention())[0]!.status, "snoozed");
  await j2.attentionUpdate(items[0]!.id, "done");
  assert.equal((await j2.attention()).length, 0);
  assert.equal((await j2.attention(true)).length, 1);
  assert.match(await j2.command("/waiting"), /Nothing is waiting/);
  assert.equal(extractBlocks("```attention\n{\"why\":\"no title\"}\n```").attention.length, 0);
  void jarvis;
});

test("submit answers at once; the final follows; a slow delegate posts a late report", async () => {
  const { store } = make();
  const { mockProvider: mp, ModelRouter: MR, Jarvis: J } = await import("../src/index.js");
  const slow = mp("m"); const base = slow.run.bind(slow);
  slow.run = async (req) => { if (req.agent.id === "lucas") await new Promise((r) => setTimeout(r, 300)); return base(req); };
  const j2 = new J({ store, router: new MR({ store, providers: { claude: [slow], grok: [slow] } }) });
  J.DELEGATE_TIMEOUT_MS = 100;
  const t0 = Date.now();
  const { message, done } = await j2.submit("Status from @stella and @lucas please", { channel: "telegram" });
  assert.equal(message.channel, "telegram");
  assert.ok(Date.now() - t0 < 250, "submit returns before the work is done");
  const out = await done;
  const ack = out.find((m) => m.kind === "ack")!;
  assert.match(ack.text, /Asking Stella and Lucas/);
  assert.equal(ack.replyTo, message.id);
  assert.equal(ack.channel, "telegram");
  const final = out.find((m) => m.kind === "final")!;
  assert.match(final.text, /Lucas/); // named as still working
  await new Promise((r) => setTimeout(r, 400));
  const chat = await store.chat.list();
  assert.ok(chat.some((m) => m.kind === "progress" && m.agentId === "lucas" && /Late report/.test(m.text)));
  J.DELEGATE_TIMEOUT_MS = 180_000;
});
