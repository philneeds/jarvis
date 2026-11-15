import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleConnector, Jarvis, ModelRouter, memoryStore, mockProvider, setAgentConfig, getAgentConfig, philDay, type Today } from "../src/index.js";
import { keepList } from "../src/jarvis/orchestrator.js";

/** Regressions from the Nov 15 audit: ways a card could run without Phil, and Undo that restored the wrong thing. */
function make() {
  const store = memoryStore();
  const router = new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } });
  return { store, jarvis: new Jarvis({ store, router }) };
}
const mem = async (store: ReturnType<typeof memoryStore>) => (await store.memory.list()).map((m) => `${m.key}=${m.value}`).sort();
const note = (i: number) => ({ scope: "phil", key: `k${i}`, value: `v${i}` });

test("a memory tidy is checked whole before anything is deleted", async () => {
  assert.throws(() => keepList("nope"), /needs a keep list/);
  assert.throws(() => keepList([note(0), null]), /no scope, key or value/);
  assert.equal(keepList([note(1), note(1), { ...note(1), value: "last wins" }]).length, 1, "copies of one key are one note");
  const { jarvis, store } = make();
  for (let i = 0; i < 4; i++) await store.memory.set({ ...note(i), source: "phil" });
  // A broken list (an empty entry in the middle): the card waits, and memory is untouched.
  const bad = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "tidy", body: "x", payload: { action: "memory.replace", keep: [note(0), null, note(2)] } });
  assert.equal(bad.status, "pending");
  assert.match(bad.note ?? (await store.approvals.get(bad.id))?.note ?? "", /Waits for you/);
  assert.deepEqual(await mem(store), ["k0=v0", "k1=v1", "k2=v2", "k3=v3"]);
  // Phil approves it anyway: it fails cleanly and still nothing is lost.
  const forced = await jarvis.decide(bad.id, "approved");
  assert.match(forced?.note ?? "", /Failed to execute memory\.replace/);
  assert.deepEqual(await mem(store), ["k0=v0", "k1=v1", "k2=v2", "k3=v3"]);
  // Fifty copies of one note don't count as fifty kept.
  for (let i = 4; i < 10; i++) await store.memory.set({ ...note(i), source: "phil" });
  const copies = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "tidy 2", body: "x", payload: { action: "memory.replace", keep: Array.from({ length: 50 }, () => note(0)) } });
  assert.equal(copies.status, "pending", "it would drop nine of ten notes");
});

test("a change too big to do alone waits for every agent, whatever their other rules", async () => {
  const { jarvis, store } = make();
  for (let i = 0; i < 10; i++) await store.memory.set({ ...note(i), source: "phil" });
  // Monica's internal work normally goes through on its own; emptying memory must not.
  const wipe = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "wipe", body: "x", payload: { action: "memory.replace", keep: [] } });
  assert.equal(wipe.status, "pending");
  assert.equal((await store.memory.list()).length, 10);
  // A mail sweep sized by its query, not by an empty ids list.
  const sweep = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "archive all", body: "x", payload: { action: "gmail.archive", query: "in:inbox", ids: [], max: 2000 } });
  assert.equal(sweep.status, "pending", "2,000 messages is Phil's call");
  // And with the reversible switch off, the size guard still holds.
  await jarvis.setReversible(false);
  const wipe2 = await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "wipe again", body: "y", payload: { action: "memory.replace", keep: [] } });
  assert.equal(wipe2.status, "pending");
});

test("the kinds Phil ticks for an agent are judged by what the card does, not what it's called", async () => {
  const { jarvis, store } = make();
  const cfg = await getAgentConfig(store, "nick");
  await setAgentConfig(store, "nick", { rules: { ...cfg.rules, autoApprove: ["record"] } });
  const post = await jarvis.requestApproval({ agentId: "nick", kind: "record", title: "post it", body: "hello", payload: { action: "x.post", text: "hello" } });
  assert.equal(post.status, "pending", "a 'record' card that posts still waits");
  const trash = await jarvis.requestApproval({ agentId: "nick", kind: "record", title: "trash", body: "x", payload: { action: "gmail.trash", query: "from:x" } });
  assert.equal(trash.status, "pending", "trashing mail never goes alone");
  const goals = await jarvis.requestApproval({ agentId: "nick", kind: "record", title: "new goals", body: "x", payload: { action: "goals.set", add: [{ name: "Agent's own goal" }] } });
  assert.equal(goals.status, "pending", "the goals themselves are Phil's call");
  assert.equal((await jarvis.goals()).length, 0);
  const plain = await jarvis.requestApproval({ agentId: "nick", kind: "record", title: "noted", body: "for the record" });
  assert.equal(plain.status, "approved", "a plain record, which is what he ticked, still goes through");
  // With "post" ticked as well, the post goes.
  await setAgentConfig(store, "nick", { rules: { ...cfg.rules, autoApprove: ["record", "post"] } });
  const post2 = await jarvis.requestApproval({ agentId: "nick", kind: "record", title: "post it 2", body: "hello again", payload: { action: "x.post", text: "hello again" } });
  assert.notEqual(post2.status, "pending");
});

test("a card that runs on its own can't take a waiting card off Phil's list; a money card only gives way to another", async () => {
  const { jarvis, store } = make();
  const money = await jarvis.requestApproval({ agentId: "david", kind: "money", title: "Pay the coach $400", body: "x", payload: { action: "payment.send", amount: 400 }, runId: "r1" });
  assert.equal(money.status, "pending");
  // His next card is today's three (runs on its own) and names the money card as replaced.
  const today = await jarvis.requestApproval({ agentId: "david", kind: "record", title: "Today's three", body: "x", payload: { action: "today.set", items: [{ text: "Call the coach" }] }, runId: "r2" }, { replaces: [money.id] });
  assert.equal(today.status, "approved");
  assert.equal((await store.approvals.get(money.id))?.status, "pending", "the money card is still in front of Phil");
  // A waiting, non-money card naming it: the money card stays and the new card says so.
  const plan = await jarvis.requestApproval({ agentId: "david", kind: "other", title: "New coaching plan", body: "x", payload: { action: "plan.propose" }, runId: "r3" }, { replaces: [money.id] });
  assert.equal(plan.status, "pending");
  assert.equal((await store.approvals.get(money.id))?.status, "pending");
  assert.match(plan.effect ?? "", /Overlaps "Pay the coach \$400" \(still waiting: a money or strategy card is only replaced by another one\)/);
  // A revised money card does replace it.
  const money2 = await jarvis.requestApproval({ agentId: "david", kind: "money", title: "Pay the coach $350", body: "x", payload: { action: "payment.send", amount: 350 }, runId: "r4" }, { replaces: [money.id] });
  assert.equal(money2.status, "pending");
  assert.match((await store.approvals.get(money.id))?.note ?? "", /^superseded/);
  assert.match(money2.effect ?? "", /Replaces the older card: "Pay the coach \$400"/);
});

test("re-sending a goal's benchmarks keeps the ones already met", async () => {
  const { jarvis } = make();
  const g = await jarvis.addGoal({ name: "Close 5 roofs", venture: "jdpm" });
  await jarvis.updateGoal(g.id, { benchmarks: [{ text: "Quote sent", weight: 1, done: true }, { text: "Contract signed", weight: 1 }] });
  assert.equal((await jarvis.goals())[0]!.pct, 50);
  assert.equal((await jarvis.trophies()).length, 1);
  // David re-plans in the shape his brief gives him: text and weight, no "done".
  const a = await jarvis.requestApproval({ agentId: "david", kind: "record", title: "Benchmarks", body: "x", payload: { action: "goals.benchmarks", id: g.id, benchmarks: [{ text: "Quote sent", weight: 1 }, { text: "Contract signed", weight: 1 }, { text: "Deposit paid", weight: 1 }] } });
  assert.equal(a.status, "approved");
  const after = (await jarvis.goals())[0]!;
  assert.deepEqual(after.benchmarks!.map((b) => b.done), [true, false, false], "the met one stays met");
  assert.equal((await jarvis.trophies()).length, 1, "and keeps its trophy");
  // Saying done:false on purpose still unticks.
  await jarvis.requestApproval({ agentId: "david", kind: "record", title: "Benchmarks 2", body: "y", payload: { action: "goals.benchmarks", id: g.id, benchmarks: [{ text: "Quote sent", weight: 1, done: false }, { text: "Contract signed", weight: 1 }] } });
  assert.equal((await jarvis.trophies()).length, 0);
});

test("undoing two memory tidies, newest first, ends exactly where it started", async () => {
  const { jarvis, store } = make();
  for (let i = 0; i < 4; i++) await store.memory.set({ ...note(i), source: "phil" });
  await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "tidy 1", body: "a", payload: { action: "memory.replace", keep: [note(0), note(1), { scope: "phil", key: "merged-a", value: "k2+k3" }] } });
  await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "tidy 2", body: "b", payload: { action: "memory.replace", keep: [note(0), { scope: "phil", key: "merged-b", value: "k1+merged-a" }] } });
  assert.deepEqual(await mem(store), ["k0=v0", "merged-b=k1+merged-a"]);
  const [second, first] = await jarvis.autoDone();
  assert.equal((await jarvis.undoAuto(second!.id)).ok, true);
  const r = await jarvis.undoAuto(first!.id);
  assert.equal(r.ok, true);
  assert.deepEqual(await mem(store), ["k0=v0", "k1=v1", "k2=v2", "k3=v3"], "no merged leftovers");
  assert.doesNotMatch(r.result, /remembered since/);
});

test("Undo won't bring back what Phil himself agreed to drop, or overwrite today's ticks", async () => {
  const { jarvis, store } = make();
  for (let i = 0; i < 4; i++) await store.memory.set({ ...note(i), source: "phil" });
  await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "tidy", body: "a", payload: { action: "memory.replace", keep: [note(0), note(1), note(2)] } });
  const [auto] = await jarvis.autoDone();
  // Later Phil approves a tidy himself (the switch off, so it waits for him).
  await jarvis.setReversible(false);
  const his = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "Phil's tidy", body: "b", payload: { action: "memory.replace", keep: [note(0), note(1)] } });
  await new Promise((r) => setTimeout(r, 5));
  await jarvis.decide(his.id, "approved");
  const r = await jarvis.undoAuto(auto!.id);
  assert.equal(r.ok, false);
  assert.match(r.result, /you approved "Phil's tidy" after this/);
  assert.deepEqual(await mem(store), ["k0=v0", "k1=v1"]);
  // Today's three: David sets it, Phil ticks one, Undo refuses instead of wiping the tick.
  await jarvis.setReversible(true);
  await jarvis.requestApproval({ agentId: "david", kind: "record", title: "Today", body: "c", payload: { action: "today.set", items: [{ text: "Call Tracy" }, { text: "Send quote" }] } });
  const { today: t } = await jarvis.today();
  await jarvis.toggleToday(t.items[0]!.id);
  const set = (await jarvis.autoDone()).find((x) => x.action === "today.set")!;
  const u = await jarvis.undoAuto(set.id);
  assert.equal(u.ok, false);
  assert.match(u.result, /changed after this/);
  assert.equal((await jarvis.today()).today.items[0]!.done, true);
});

test("a card approved twice at the same moment runs once", async () => {
  const { jarvis } = make();
  let runs = 0;
  jarvis.addConnector({ id: "t", tools: () => [], executors: () => ({ "note.send": async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return "sent"; } }) } as never);
  const a = await jarvis.requestApproval({ agentId: "oscar", kind: "send", title: "Send it", body: "x", payload: { action: "note.send" } });
  assert.equal(a.status, "pending");
  await Promise.all([jarvis.decide(a.id, "approved"), jarvis.decide(a.id, "approved"), jarvis.decide(a.id, "approved")]);
  assert.equal(runs, 1);
});

test("Gmail's own folders can't be used as a label, so 'label it Trash' can't trash mail", async () => {
  const store = memoryStore(); await store.init();
  const calls: { url: string; body: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); calls.push({ url: u, body: String(init?.body ?? "") });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at1", refresh_token: "rt", expires_in: 3600, scope: "x" });
    if (u.includes("/userinfo")) return json({ email: "owner@example.com" });
    if (u.includes("/messages?q=")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
    if (u.endsWith("/users/me/labels")) return json({ labels: [{ id: "TRASH", name: "TRASH", type: "system" }, { id: "L1", name: "Receipts", type: "user" }, { id: "CATEGORY_PROMOTIONS", name: "Deals", type: "system" }] });
    if (u.endsWith("/messages/batchModify")) return new Response(null, { status: 204 });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: f });
  await g.exchangeCode("code");
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  jarvis.addConnector(g);
  for (const label of ["trash", "Spam", " INBOX ", "Deals"]) {
    const a = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: `label ${label}`, body: label, payload: { action: "gmail.label", query: "in:inbox", label, max: 50 } });
    assert.match(a.note ?? "", /Failed to execute gmail\.label: .*Gmail's own folders/, `${label}: ${a.note}`);
  }
  assert.equal(calls.filter((c) => c.url.endsWith("/batchModify")).length, 0, "nothing was modified");
  assert.equal((await jarvis.autoDone()).length, 0, "and nothing is listed as done");
  // A real label works, and only touches mail that doesn't carry it yet.
  const ok = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "label receipts", body: "r", payload: { action: "gmail.label", query: "from:store", label: "Receipts", max: 50 } });
  assert.match(ok.note ?? "", /Labelled 2 message/);
  assert.ok(calls.some((c) => decodeURIComponent(c.url).replace(/\+/g, " ").includes("(from:store) -label:Receipts")));
  const arch = await jarvis.requestApproval({ agentId: "oscar", kind: "record", title: "archive promos", body: "p", payload: { action: "gmail.archive", query: "category:promotions older_than:30d", max: 50 } });
  assert.match(arch.note ?? "", /Archived 2 message/);
  assert.ok(calls.some((c) => decodeURIComponent(c.url).replace(/\+/g, " ").includes("in:inbox (category:promotions older_than:30d)")));
});

test("a 'Decide' item ticks when Phil decides, not when the card is replaced or withdrawn", async () => {
  const { jarvis, store } = make();
  const first = await jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Tracy", body: "v1", payload: { action: "gmail.send", to: "t@example.com", subject: "Roof", body: "v1" }, runId: "r1" });
  await jarvis.repickToday();
  let { today } = await jarvis.today();
  assert.equal(today.items.find((i) => i.ref?.id === first.id)?.done, false);
  // Stella revises: the old card is superseded, the new one waits. Nothing was decided.
  const second = await jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Tracy (revised)", body: "v2", payload: { action: "gmail.send", to: "t@example.com", subject: "Roof", body: "v2" }, runId: "r2" });
  assert.match((await store.approvals.get(first.id))?.note ?? "", /^superseded/);
  ({ today } = await jarvis.today());
  assert.equal(today.items.find((i) => i.ref?.id === first.id)?.done, false, "a withdrawn card isn't a decision");
  assert.equal((await jarvis.baseSummary()).player.from.fullDays, 0);
  // Phil decides the one on today's list after a fresh pick: now it ticks.
  await jarvis.repickToday();
  await jarvis.decide(second.id, "rejected");
  ({ today } = await jarvis.today());
  assert.equal(today.items.find((i) => i.ref?.id === second.id)?.done, true);
});

test("a finished day stays finished when the list is picked again; unticking takes it back", async () => {
  const { jarvis } = make();
  await jarvis.setToday([{ text: "Call Tracy" }, { text: "Send quote" }], "david");
  let { today } = await jarvis.today();
  for (const i of today.items) await jarvis.toggleToday(i.id);
  assert.equal((await jarvis.today()).streak, 1);
  await jarvis.repickToday();
  await jarvis.setToday([{ text: "Something else" }], "david");
  const after = await jarvis.baseSummary();
  assert.equal(after.streak, 1, "the day was done; a new list doesn't undo that");
  assert.equal(after.player.from.fullDays, 1);
  // Phil ticks and then unticks on the new list: that is him saying it isn't done.
  ({ today } = await jarvis.today());
  await jarvis.toggleToday(today.items[0]!.id);
  await jarvis.toggleToday(today.items[0]!.id);
  assert.equal((await jarvis.baseSummary()).streak, 0);
});

test("something finished late still counts for the day that just ended", async () => {
  const { jarvis, store } = make();
  const g = await jarvis.addGoal({ name: "Close 5 roofs" });
  await jarvis.updateGoal(g.id, { benchmarks: [{ text: "Quote sent", weight: 1 }] });
  const bench = (await jarvis.goals())[0]!.benchmarks![0]!;
  const d = new Date(`${philDay()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);
  const list: Today = { date: yesterday, by: "auto", pickedAt: new Date().toISOString(), items: [{ id: `${yesterday}:0`, text: "Quote sent", done: false, goalId: g.id, ref: { kind: "benchmark", id: bench.id, goalId: g.id } }] };
  await store.settings.set("today", list);
  await store.settings.set("today.log", { [yesterday]: { done: 0, total: 1 } });
  // Met in the evening with no HQ tab open; the next look is the following morning.
  await jarvis.updateGoal(g.id, { benchmarksDone: { done: [bench.id], undone: [] } });
  const { streak } = await jarvis.today();
  assert.equal(streak, 1, "yesterday is a full day");
});

test("setup: an agent whose only run failed isn't 'ready' after a pause and resume", async () => {
  const { jarvis, store } = make();
  await store.settings.set("phase", 1);
  jarvis.connectionProbe = async () => new Set(["Google", "X", "Spotify", "Kubera", "Robinhood", "GoHighLevel", "Discord", "GitHub", "Apple Health"] as never);
  await store.agentState.set("karol", { status: "error", lastError: "GoHighLevel 401", lastRunAt: new Date().toISOString() });
  await store.agentState.set("karol", { status: "idle" }); // what a pause and resume, or a decision, leaves behind
  const karol = (await jarvis.setupStatus()).find((s) => s.id === "karol")!;
  assert.equal(karol.ok, false);
  assert.match(karol.error ?? "", /401/);
  await store.agentState.set("karol", { status: "idle", lastError: "", lastRunAt: new Date().toISOString() });
  assert.equal((await jarvis.setupStatus()).find((s) => s.id === "karol")!.ok, true, "a run that worked clears it");
});

test("HQ's setup goal is housekeeping: not one of Phil's twelve, never the primary; trophies follow a goal's venture", async () => {
  const { jarvis, store } = make();
  await store.settings.set("phase", 1);
  jarvis.connectionProbe = async () => new Set();
  await jarvis.syncSetupGoal();
  const setup = (await jarvis.goals())[0]!;
  assert.equal(setup.primary, false);
  const mine = await jarvis.addGoal({ name: "JD PM to $1M" });
  assert.equal(mine.primary, true, "Phil's first goal is the primary one");
  for (let i = 0; i < 11; i++) await jarvis.addGoal({ name: `Goal ${i}` });
  await assert.rejects(jarvis.addGoal({ name: "A thirteenth" }), /at most 12/);
  assert.match(await jarvis.syncSetupGoal(), /live agents ready/, "the hourly check still works with twelve goals");
  // A benchmark met before the goal had a venture counts for the venture once it has one.
  await jarvis.updateGoal(mine.id, { benchmarks: [{ text: "First $100k", weight: 1, done: true }, { text: "First $100k", weight: 1 }, { text: "Second crew", weight: 1 }] });
  assert.equal((await jarvis.goals()).find((g) => g.id === mine.id)!.benchmarks!.length, 2, "the same text twice is one benchmark");
  assert.equal((await jarvis.baseSummary()).levels.jdpm, undefined);
  await jarvis.updateGoal(mine.id, { venture: "jdpm" });
  assert.equal((await jarvis.baseSummary()).levels.jdpm?.level, 2);
});
