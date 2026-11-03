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
