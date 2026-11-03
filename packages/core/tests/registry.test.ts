import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTS, AGENT_BY_ID, findAgent, leads, teamSize, VENTURES, MODELS } from "../src/index.js";

test("Jarvis + 52 specialist agents in four layers, 12 leads", () => {
  assert.equal(AGENTS.length, 53);
  assert.equal(AGENTS.filter((a) => a.id !== "jarvis").length, 52);
  assert.equal(leads().length, 12);
  assert.equal(new Set(AGENTS.map((a) => a.id)).size, 53);
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
  assert.equal(teamSize("doc"), 3);
});

test("findAgent resolves names, ids and @mentions", () => {
  assert.equal(findAgent("@stella")?.id, "stella");
  assert.equal(findAgent("Charlie Munger")?.id, "munger");
  assert.equal(findAgent("munger")?.id, "munger");
  assert.equal(findAgent("Jason 2.0")?.id, "jason2");
  assert.equal(findAgent("nobody"), undefined);
});
