import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTS, AGENT_BY_ID, findAgent, leads, teamSize, VENTURES, MODELS } from "../src/index.js";
import { CHARTERS } from "../src/registry/index.js";

test("Jarvis + 47 specialist agents in four layers, 12 leads", () => {
  assert.equal(AGENTS.length, 48);
  assert.equal(AGENTS.filter((a) => a.id !== "jarvis").length, 47);
  assert.equal(leads().length, 12);
  assert.equal(new Set(AGENTS.map((a) => a.id)).size, 48);
});

test("Sales Coach and Mindset Coach are retired and folded into Stevon as skills (Phil, Nov 14-15 2026)", () => {
  for (const id of ["salescoach", "mindset"]) {
    assert.equal(AGENT_BY_ID[id], undefined, id);
    assert.equal(findAgent(`@${id}`), undefined, id);
    assert.equal(CHARTERS[id], undefined, id);
  }
  assert.equal(findAgent("Sales Coach"), undefined);
  assert.equal(findAgent("Mindset Coach"), undefined);
  // Stevon carries both jobs and reads each playbook from his own memory (agent:stevon, keys skill:sales_coaching and skill:mindset_coaching).
  assert.ok(CHARTERS.stevon!.owns.some((o) => /sales coaching/i.test(o) && o.includes("skill:sales_coaching")));
  assert.ok(CHARTERS.stevon!.owns.some((o) => /mindset coaching/i.test(o) && o.includes("skill:mindset_coaching")));
  assert.ok(!CHARTERS.stevon!.owns.some((o) => /directing.*mindset/i.test(o)), "no line still directs a Mindset Coach agent");
  assert.ok(CHARTERS.stevon!.tools?.includes("sales_data"), "Stevon keeps the sales data the coach used");
  assert.ok(CHARTERS.stevon!.tools?.includes("web_search") && CHARTERS.stevon!.tools?.includes("memory_search"), "Stevon has the tools the mindset coach had");
  assert.ok(CHARTERS.stevon!.sources?.some((s) => /training material/.test(s) && /mindset material/.test(s)), "both coaches' web sources moved to Stevon");
  assert.deepEqual(AGENTS.filter((a) => a.parent === "stevon").map((a) => a.id), ["emailai", "auditor"]);
  assert.equal(teamSize("stevon"), 2);
});

test("the Scheduler is retired and the schedule is Stevon's skill (Phil, Nov 17 2026); the Auditor is ProEdge's accounting audit bot (Phil, Nov 9 2026)", async () => {
  const { SCHEDULES, scheduleView, memoryStore } = await import("../src/index.js");
  assert.equal(AGENT_BY_ID["scheduler"], undefined);
  assert.equal(findAgent("@scheduler"), undefined);
  assert.equal(findAgent("Scheduler"), undefined);
  assert.equal(CHARTERS["scheduler"], undefined);
  assert.ok(!SCHEDULES.some((s) => s.agentId === "scheduler"));
  // Stevon makes the day's schedule himself: reads LeadPerfection and the ProEdge calendar, files one lp.assign card per day.
  const stevon = CHARTERS.stevon!;
  assert.ok(stevon.owns.some((o) => /former Scheduler/.test(o) && o.includes("lp.assign") && o.includes("skill:scheduling") && /Present\.aspx/.test(o) && /SalesSched\.aspx/.test(o)));
  assert.ok(!stevon.owns.some((o) => /until the scheduler is switched on/i.test(o)), "no line still waits on a Scheduler agent");
  for (const t of ["lp_open", "lp_report", "calendar_list_events", "google_accounts"]) assert.ok(stevon.tools?.includes(t), `Stevon has ${t}`);
  assert.ok(stevon.sources?.some((s) => /skill:scheduling/.test(s)));
  assert.ok(stevon.owns.some((o) => /Directing Email AI/.test(o) && /the Auditor/.test(o)));
  // The Auditor: under Stevon, live in phase 1, read-only, with a Friday routine that reports to Stevon and never to Phil.
  const auditor = AGENT_BY_ID["auditor"]!;
  assert.equal(auditor.layer, 2); assert.equal(auditor.parent, "stevon"); assert.equal(auditor.venture, "proedge"); assert.equal(auditor.phase, 1); assert.equal(auditor.model, "claude-sonnet");
  assert.equal(findAgent("Auditor")?.id, "auditor");
  const c = CHARTERS.auditor!;
  for (const t of ["lp_report", "sales_data", "gmail_search", "gmail_attachment", "venture_board", "memory_search"]) assert.ok(c.tools?.includes(t), `Auditor has ${t}`);
  for (const t of c.tools ?? []) assert.ok(!/create|update|delete|send|draft|order|assign|post/.test(t), `Auditor's ${t} isn't a read tool`);
  assert.equal(c.autoApprove, undefined, "nothing goes through on its own; it has nothing to approve");
  assert.ok(c.owns.some((o) => /skill:commission_rules/.test(o)) && c.owns.some((o) => /pmarino@getproedge\.com/.test(o)) && c.owns.some((o) => /kind discrepancy/.test(o)));
  assert.ok(c.open!.some((q) => /commission rate/.test(q)));
  assert.ok(c.handsOff?.some(([, to]) => to === "stevon"));
  const weekly = SCHEDULES.find((s) => s.id === "auditor-weekly")!;
  assert.equal(weekly.agentId, "auditor"); assert.equal(weekly.when, "weekly:fri@07:00"); assert.equal(weekly.phase, 1); assert.equal(weekly.to, "stevon"); assert.ok(!weekly.push);
  assert.match(weekly.task, /lp_report/); assert.match(weekly.task, /sales_data/); assert.match(weekly.task, /skill:commission_rules/); assert.match(weekly.task, /goes to Stevon, not Phil/);
  const store = memoryStore();
  await store.settings.set("phase", 1); // where HQ stands today (Nov 17 2026)
  const view = await scheduleView(store, new Date(2026, 10, 17, 9, 0));
  const v = view.find((x) => x.id === "auditor-weekly")!;
  assert.equal(v.to, "stevon"); assert.ok(v.active, "live in phase 1, like Stevon");
  assert.match(v.summary, /commissions/);
});

test("the health team is one agent: Metro leads, Doc, Sean and Gordon are retired and live on as his skills (Phil, Nov 14 2026)", () => {
  for (const id of ["doc", "sean", "gordon"]) {
    assert.equal(AGENT_BY_ID[id], undefined, id);
    assert.equal(findAgent(`@${id}`), undefined, id);
    assert.equal(CHARTERS[id], undefined, id);
  }
  const metro = AGENT_BY_ID["metro"]!;
  assert.equal(metro.layer, 1); assert.equal(metro.parent, "jarvis"); assert.equal(metro.venture, "personal"); assert.equal(metro.phase, 3);
  assert.ok(leads().some((a) => a.id === "metro"), "Metro took Doc's seat among the 12 leads");
  assert.deepEqual(AGENTS.filter((a) => a.venture === "personal").map((a) => a.id), ["lip", "david", "metro"], "the Personal & health venture is three agents, all under Jarvis");
  assert.equal(teamSize("metro"), 0, "no coaches under him: the coaching is his");
  // Metro reads the Apple Health data himself and each former coach is a playbook in his memory (agent:metro).
  assert.ok(CHARTERS.metro!.tools?.includes("health_summary"));
  for (const skill of ["skill:daily_health_read", "skill:sleep", "skill:fitness", "skill:nutrition"]) assert.ok(CHARTERS.metro!.owns.some((o) => o.includes(skill)), skill);
  assert.ok(CHARTERS.metro!.sources?.some((s) => /skill:sleep/.test(s)), "the playbooks are listed where he looks things up");
  // The pointers other agents follow for health matters moved with the job.
  assert.ok(CHARTERS.monica!.handsOff?.some(([, to]) => to === "metro") && !CHARTERS.monica!.handsOff?.some(([, to]) => to === "doc"));
  assert.ok(CHARTERS.lip!.handsOff?.some(([, to]) => to === "metro") && !CHARTERS.lip!.handsOff?.some(([, to]) => to === "doc"));
  for (const c of Object.values(CHARTERS)) for (const [, to] of c.handsOff ?? []) assert.ok(AGENT_BY_ID[to], `hand-off to a retired agent: ${to}`);
});

test("every parent, link and venture resolves", () => {
  for (const a of AGENTS) {
    if (a.parent) assert.ok(AGENT_BY_ID[a.parent], `${a.id} parent ${a.parent}`);
    for (const l of a.links ?? []) assert.ok(AGENT_BY_ID[l], `${a.id} link ${l}`);
    assert.ok(VENTURES[a.venture], `${a.id} venture`);
    assert.ok(MODELS[a.model], `${a.id} model`);
  }
});

test("team sizes match the scope doc", () => {
  assert.equal(teamSize("stella"), 6);
  assert.equal(teamSize("mantis"), 10);
  assert.equal(teamSize("munger"), 7);
  assert.equal(teamSize("poseidon"), 8);
  assert.equal(teamSize("stevon"), 2);
});

test("findAgent resolves names, ids and @mentions", () => {
  assert.equal(findAgent("@stella")?.id, "stella");
  assert.equal(findAgent("Charlie Munger")?.id, "munger");
  assert.equal(findAgent("munger")?.id, "munger");
  assert.equal(findAgent("Jason 2.0")?.id, "jason2");
  assert.equal(findAgent("nobody"), undefined);
});
