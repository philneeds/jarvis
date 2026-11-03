import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBlocks, parsePlan } from "../src/index.js";

test("approval and remember blocks are pulled out of a reply", () => {
  const raw = `Draft is ready.\n\n\`\`\`approval\n{"kind":"send","title":"Email the Smiths a quote","body":"Send the $4,200 kitchen quote","payload":{"to":"smith@example.com"}}\n\`\`\`\n\n\`\`\`remember\n{"scope":"venture:jdpm","key":"smith-quote","value":"$4,200 kitchen quote sent for approval"}\n\`\`\`\nAnything else?`;
  const r = extractBlocks(raw);
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0]!.kind, "send");
  assert.equal(r.approvals[0]!.payload?.to, "smith@example.com");
  assert.equal(r.remember.length, 1);
  assert.equal(r.remember[0]!.scope, "venture:jdpm");
  assert.match(r.text, /\[Approval queued: Email the Smiths a quote\]/);
  assert.doesNotMatch(r.text, /remember/);
});

test("unknown approval kinds become 'other'; bad JSON is left alone", () => {
  const r = extractBlocks("```approval\n{\"kind\":\"nuke\",\"title\":\"x\",\"body\":\"y\"}\n```\n```approval\nnot json\n```");
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0]!.kind, "other");
  assert.match(r.text, /not json/);
});

test("parsePlan tolerates fences and prose", () => {
  assert.deepEqual(parsePlan('{"reply":"hi","delegate":[]}'), { reply: "hi", delegate: [] });
  assert.deepEqual(parsePlan('```json\n{"delegate":[{"agent":"@Stella","task":"leads"}]}\n```'), { reply: undefined, delegate: [{ agent: "stella", task: "leads" }] });
  assert.deepEqual(parsePlan('Sure. {"reply":"ok"} done'), { reply: "ok", delegate: [] });
  assert.deepEqual(parsePlan("plain text"), { reply: "plain text", delegate: [] });
});
