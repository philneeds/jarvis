import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider, extractBlocks, getAgent, VENTURE_DASH, TOOLS } from "../src/index.js";

function make() {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("g")] } }) });
  return { store, jarvis };
}

test("metric and record blocks are parsed and bad ones dropped", () => {
  const r = extractBlocks('ok\n```metric\n{"venture":"jdpm","key":"leads_week","value":7}\n```\n```metric\n{"venture":"jdpm","key":"leads_week","value":"seven"}\n```\n```record\n[{"venture":"jdpm","kind":"lead","title":"Smith","status":"quoted","fields":{"value":4200}},{"venture":"jdpm","kind":"lead"}]\n```');
  assert.equal(r.metrics.length, 1);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0]!.status, "quoted");
  assert.equal(r.text, "ok");
});

test("an agent's reply feeds its venture dashboard; unknown kinds and statuses are handled", async () => {
  const { jarvis, store } = make();
  await jarvis.runAgent(getAgent("karol")!, "log lead for Dana Smith", { direct: true });
  const d = await jarvis.ventureDashboard("jdpm");
  assert.equal(d.records.find((k) => k.kind === "lead")!.items[0]!.title, "Dana Smith");
  assert.equal(d.metrics.find((m) => m.key === "leads_week")!.series.length, 1);
  await assert.rejects(jarvis.upsertRecord({ venture: "jdpm", kind: "invoice", title: "x", source: "phil" }), /no record kind "invoice"/);
  const lead = d.records.find((k) => k.kind === "lead")!.items[0]!;
  const upd = await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", id: lead.id, title: lead.title, status: "bogus", fields: { next: "call Tuesday" }, source: "phil" });
  assert.equal(upd.status, "new"); // unknown status keeps the old one
  assert.equal(upd.fields.next, "call Tuesday");
  assert.equal(upd.fields.source, "referral"); // fields merge
  assert.equal((await store.records.list("jdpm")).length, 1);
});

test("summaries cover every venture and the board tool reads back", async () => {
  const { jarvis, store } = make();
  await jarvis.recordMetric("money", "net_worth", 125000, "phil");
  await jarvis.recordMetric("money", "net_worth", 127500, "munger");
  const sums = await jarvis.ventureSummaries();
  assert.equal(sums.length, Object.keys(VENTURE_DASH).length - 1);
  const money = sums.find((s) => s.venture.id === "money")!;
  assert.equal(money.headline[0]!.latest, 127500);
  const dash = await jarvis.ventureDashboard("money");
  assert.equal(dash.metrics[0]!.delta, 2500);
  const tool = TOOLS.find((t) => t.name === "venture_board")!;
  assert.match(await tool.handler({ venture: "money" }, { store, agentId: "munger" }), /net_worth=127500/);
  assert.equal(await tool.handler({ venture: "nope" }, { store, agentId: "munger" }), "No such venture.");
});

test("a run's own summary stays off the board; real items still land", async () => {
  const { Jarvis, ModelRouter, memoryStore, mockProvider, looksLikeRunReport, getAgent } = await import("../src/index.js");
  for (const t of ["Daily lead check 2026-11-14 (7:15 run): no new leads", "Morning lead check: nothing new", "No new leads today", "Weekly holdings review 11/14"]) assert.equal(looksLikeRunReport(t), true, t);
  for (const t of ["Howard Bailey – roof overlay, 4544 NY-14, Geneva NY 14456", "Mike Tracy – roof only, 260 Longridge Ave", "Daily Grind Cafe – new roof", "NVDA"]) assert.equal(looksLikeRunReport(t), false, t);
  // Real items that used to read as reports and were dropped.
  for (const t of ["Dana Smith – siding only, no new windows", "Karen White – furnace did not run last night", "Roof check 2026-11-20 – Bailey", "Daily 5k run", "Weekly market review thread", "Nightly backup check – verify a restore", "No heat in upstairs unit - call back"]) assert.equal(looksLikeRunReport(t), false, t);
  for (const t of ["Lead check 2026-11-14: nothing came in", "Daily lead check: could not run, GHL unreachable", "Inbox sweep did not run"]) assert.equal(looksLikeRunReport(t), true, t);
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  const karol = getAgent("karol")!;
  // absorb is private; the same path runs when an agent's reply carries record blocks.
  await (jarvis as unknown as { absorb: (...a: unknown[]) => Promise<void> }).absorb(karol, [], [], "run1", [], [
    { venture: "jdpm", kind: "lead", title: "Daily lead check 2026-11-14 (7:15 run): no new leads" },
    { venture: "jdpm", kind: "lead", title: "Howard Bailey – roof overlay", status: "new", fields: { phone: "315-555-0100" } },
    { venture: "jdpm", kind: "nonsense", title: "A kind the board doesn't have" },
  ]);
  const leads = await store.records.list("jdpm", "lead");
  assert.deepEqual(leads.map((l) => l.title), ["Howard Bailey – roof overlay"]);
  const log = await store.activity.list({ limit: 20 });
  assert.ok(log.some((e) => /read like a run summary/.test(e.summary)));
  assert.ok(log.some((e) => e.kind === "error" && /wasn't saved/.test(e.summary)), "a bad entry is logged, and doesn't stop the rest");
  const dash = await jarvis.ventureDashboard("jdpm");
  assert.equal(dash.records.find((k) => k.kind === "lead")!.addedWeek, 1);
});

test("run summaries already on the boards are taken off on start; Phil's own entries and real leads stay", async () => {
  const { Jarvis, ModelRouter, memoryStore, mockProvider, looksLikeRunReport } = await import("../src/index.js");
  for (const t of ["Post-reconnect check 2026-11-13: Gmail OK, no new leads", "Daily lead check 2026-11-13 (7:15 run): could not run (Google token 400)", "Lead check 2026-11-12: inbox quiet"]) assert.equal(looksLikeRunReport(t), true, t);
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  const now = new Date().toISOString();
  const rec = (id: string, title: string, source: string) => store.records.upsert({ id, venture: "jdpm", kind: "lead", title, status: "new", fields: {}, source, createdAt: now, updatedAt: now });
  await rec("a", "Daily lead check 2026-11-14 (7:15 run): no new leads", "karol");
  await rec("b", "Post-reconnect check 2026-11-13: Gmail OK, no new leads", "karol");
  await rec("c", "Howard Bailey – roof overlay", "karol");
  await rec("d", "No new leads this week, call the old list", "phil");
  assert.equal(await jarvis.pruneRunReports(), 2);
  assert.deepEqual((await store.records.list("jdpm", "lead")).map((r) => r.id).sort(), ["c", "d"]);
  assert.deepEqual((await store.settings.get<{ id: string }[]>("records.pruned", [])).map((r) => r.id).sort(), ["a", "b"], "kept, not lost");
  assert.equal(await jarvis.pruneRunReports(), 0, "a second start finds nothing");
});

test("duplicates: an agent re-logging someone updates them, a DUPLICATE mark takes the copy off, and old marks are cleared on start", async () => {
  const { Jarvis, ModelRouter, memoryStore, mockProvider, isDuplicateMark } = await import("../src/index.js");
  assert.equal(isDuplicateMark("DUPLICATE – Mick Kuberka (see a223ae20)"), true);
  assert.equal(isDuplicateMark("Duplicate of a223ae20"), true);
  assert.equal(isDuplicateMark("Duplicate check for Tracy"), false, "the word alone isn't a mark");
  assert.equal(isDuplicateMark("Duplicate keys – 14 Elm St"), false, "a job about duplicate keys is a job");
  assert.equal(isDuplicateMark("Mick Kuberka – duplicate roof quote"), false);
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  const tracy = (await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "Mike Tracy – roof only, 260 Longridge Ave", status: "won", fields: { phone: "585-621-2237" }, source: "karol" }))!;
  // Same person by name, and by phone: no new row, nothing downgraded, gaps filled.
  const again = await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "Mike Tracy", status: "new", fields: { source: "info@ mailbox" }, source: "karol" });
  assert.equal(again!.id, tracy.id);
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "M. Tracy (roof)", fields: { phone: "(585) 621-2237", source: "ignored, already set" }, source: "stella" });
  let leads = await store.records.list("jdpm", "lead");
  assert.equal(leads.length, 1);
  assert.equal(leads[0]!.status, "won", "re-logging never turns a won lead back into new");
  assert.equal(leads[0]!.fields.source, "info@ mailbox");
  assert.equal(leads[0]!.title, "Mike Tracy – roof only, 260 Longridge Ave");
  // Phil adding by hand is never merged: he may mean a second job for the same customer.
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "Mike Tracy – gutters", source: "phil" });
  leads = await store.records.list("jdpm", "lead");
  assert.equal(leads.length, 2);
  // An agent can't take Phil's own entry off the board by calling it a duplicate, or by updating it first.
  const his = leads.find((l) => l.title === "Mike Tracy – gutters")!;
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", id: his.id, title: "Mike Tracy – gutters", fields: { note: "called" }, source: "karol" });
  assert.equal((await store.records.get(his.id))!.source, "phil", "an agent's update leaves it Phil's");
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", id: his.id, title: "DUPLICATE – Mike Tracy (see b9ad269e)", source: "karol" });
  assert.equal((await store.records.list("jdpm", "lead")).length, 2);
  assert.equal(await jarvis.pruneRunReports(), 0);
  await jarvis.removeRecord("jdpm", his.id);
  // Different people who share a first word or a surname are different items.
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "Smith – roof, 12 Oak St", source: "karol" });
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "Smith – siding, 99 Elm Ave", source: "karol" });
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "New roof – Howard Bailey", source: "karol" });
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "New roof – Mike Stone", source: "karol" });
  // The same full name where one title continues the other is one item.
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "Dana Fox – kitchen", source: "karol" });
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "Dana Fox – kitchen, wants a quote by Friday", fields: { phone: "585-555-0144" }, source: "stella" });
  leads = await store.records.list("jdpm", "lead");
  assert.deepEqual(leads.map((l) => l.title).sort(), ["Dana Fox – kitchen", "Mike Tracy – roof only, 260 Longridge Ave", "New roof – Howard Bailey", "New roof – Mike Stone", "Smith – roof, 12 Oak St", "Smith – siding, 99 Elm Ave"]);
  assert.equal(leads.find((l) => l.title === "Dana Fox – kitchen")!.fields.phone, "585-555-0144");
  for (const l of leads) if (!/Tracy/.test(l.title)) await store.records.remove(l.id);
  // An agent marking its own copy as a duplicate takes it off the board (kept in the archive).
  const copy = (await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", title: "Tracy household, second entry", source: "karol" }))!;
  await jarvis.upsertRecord({ venture: "jdpm", kind: "lead", id: copy.id, title: "DUPLICATE – Mike Tracy (see b9ad269e)", source: "karol" });
  assert.equal((await store.records.list("jdpm", "lead")).length, 1);
  assert.ok((await store.settings.get<{ id: string }[]>("records.pruned", [])).some((r) => r.id === copy.id));
  // Marks left on the board from before are cleared on start.
  const now = new Date().toISOString();
  await store.records.upsert({ id: "old", venture: "jdpm", kind: "lead", title: "DUPLICATE – Mick Kuberka (see a223ae20)", status: "quoted", fields: {}, source: "karol", createdAt: now, updatedAt: now });
  assert.equal(await jarvis.pruneRunReports(), 1);
  assert.equal((await store.records.list("jdpm", "lead")).length, 1);
});
