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
  assert.deepEqual(AGENTS.filter((a) => a.parent === "stevon").map((a) => a.id), ["scheduler", "emailai"]);
  assert.equal(teamSize("stevon"), 2);
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
