import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider } from "../src/index.js";
import { extractBlocks } from "../src/jarvis/blocks.js";

function make() {
  const store = memoryStore();
  const router = new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } });
  return { store, jarvis: new Jarvis({ store, router }) };
}
const fold = (title: string, extra: Record<string, unknown> = {}) => ({ agentId: "oscar", kind: "config" as const, title, body: `MOVES to @stevon: ${title}`, payload: { action: "agent.fold", into: "stevon", ...extra } });

test("an approval block can name the waiting cards it replaces", () => {
  const { approvals } = extractBlocks('```approval\n{"kind":"strategy","title":"Fold both","body":"b","replaces":["#1A2B3C4D","not an id!", "1a2b3c4d"]}\n```');
  assert.deepEqual(approvals[0]!.replaces, ["1a2b3c4d"]);
  assert.equal(extractBlocks('```approval\n{"kind":"other","title":"x","body":"b"}\n```').approvals[0]!.replaces, undefined);
});

test("a new proposal that names its older one leaves Phil with one card, up to date", async () => {
  const { jarvis, store } = make();
  const first = await jarvis.requestApproval({ ...fold("Sunset Sales Coach, fold into Stevon", { from: "salescoach" }), runId: "r1" });
  assert.equal(first.status, "pending");
  // The agent sees its waiting card, with the id to replace it by.
  const seen = await jarvis.pendingText("oscar");
  assert.match(seen, new RegExp(`${first.id.slice(0, 8)} · config · agent\\.fold · "Sunset Sales Coach, fold into Stevon"`));
  assert.equal(await jarvis.pendingText("monica"), "", "another agent's cards aren't listed");
  // Phil asks again with more: the new card names the old one (by its short id) and takes its place.
  const second = await jarvis.requestApproval({ agentId: "oscar", kind: "strategy", title: "Sunset Sales Coach + Mindset Coach, fold both into Stevon", body: "Retire both.", payload: { action: "agents.sunset_fold" }, runId: "r2" }, { replaces: [first.id.slice(0, 8)] });
  const pending = await store.approvals.list("pending");
  assert.deepEqual(pending.map((p) => p.id), [second.id], "one card waits");
  assert.match(second.effect ?? "", /Replaces the older card: "Sunset Sales Coach, fold into Stevon"/);
  assert.match((await store.approvals.get(first.id))?.note ?? "", /^superseded: replaced by the newer card/);
});

test("replacing is limited: only the agent's own cards, and never one Phil edited or asked about", async () => {
  const { jarvis, store } = make();
  const others = await jarvis.requestApproval({ agentId: "monica", kind: "other", title: "Monica's card", body: "x", payload: { action: "note.keep" }, runId: "m1" });
  const asked = await jarvis.requestApproval({ ...fold("Fold Mindset Coach", { from: "mindset" }), runId: "r1" });
  await store.approvals.update(asked.id, { thread: [{ at: new Date().toISOString(), from: "phil", text: "why?" }] });
  const next = await jarvis.requestApproval({ ...fold("Fold both coaches"), runId: "r2" }, { replaces: [others.id, asked.id] });
  const pending = (await store.approvals.list("pending")).map((p) => p.id).sort();
  assert.deepEqual(pending, [others.id, asked.id, next.id].sort(), "both stay");
  assert.match(next.effect ?? "", /Overlaps "Fold Mindset Coach" \(still waiting: you edited or asked about it\)/);
  assert.doesNotMatch(next.effect ?? "", /Monica/);
});

test("Einstein's newer ship card replaces his older one only when its commit carries it", async () => {
  const { jarvis, store } = make();
  const ship = (runId: string, title: string, sha: string, carries: string[], replaces?: string[]) =>
    jarvis.requestApproval({ agentId: "einstein", kind: "config", title: `Ship: ${title}`, body: "b", payload: { action: "code.ship", sha, title, files: ["README.md"], guardrails: [], carries }, runId }, { replaces });
  const fold = await ship("r1", "Fold the health team into Metro", "1111111", []);
  assert.equal(fold.status, "pending");
  // A later commit on top of it (Nov 15: the fold, then the fold plus the tab): approving the new card ships the fold
  // too, so the fold's card goes. workshop_submit lists what rides along in "carries".
  const tab = await ship("r2", "Condense the Personal tab", "2222222", ["Fold the health team into Metro"], [fold.id.slice(0, 8)]);
  assert.equal(tab.status, "pending");
  assert.match((await store.approvals.get(fold.id))?.note ?? "", /^superseded: replaced by the newer card/);
  assert.match(tab.effect ?? "", /Replaces the older card: "Ship: Fold the health team into Metro"/);
  // An unrelated commit naming it: the ship card stays in front of Phil, and the new card says why.
  const clap = await ship("r3", "Louder clap", "3333333", [], [tab.id]);
  assert.equal((await store.approvals.get(tab.id))?.status, "pending");
  assert.match(clap.effect ?? "", /Overlaps "Ship: Condense the Personal tab" \(still waiting: a code or update card is only replaced by a newer ship card that carries its commit\)/);
  // Another agent's card never touches it, whatever it claims to carry.
  await jarvis.requestApproval({ agentId: "oscar", kind: "config", title: "Ship: x", body: "b", payload: { action: "code.ship", sha: "4444444", title: "x", carries: ["Condense the Personal tab"] }, runId: "r4" }, { replaces: [tab.id] });
  assert.equal((await store.approvals.get(tab.id))?.status, "pending");
  assert.equal((await store.approvals.list("pending")).length, 3, "tab, clap and Oscar's wait; only the fold gave way");
});

test("the same card filed twice is one card", async () => {
  const { jarvis, store } = make();
  const a = await jarvis.requestApproval({ ...fold("Fold Sales Coach", { from: "salescoach", skill: "sales coaching" }), runId: "r1" });
  const b = await jarvis.requestApproval({ agentId: "oscar", kind: "config", title: "  fold  sales coach ", body: "MOVES to @stevon: Fold Sales Coach", payload: { skill: "sales coaching", from: "salescoach", into: "stevon", action: "agent.fold" }, runId: "r2" });
  assert.equal(b.id, a.id, "the waiting card is returned, whatever order the payload keys came in");
  assert.equal((await store.approvals.list("pending")).length, 1);
  // A different payload is a different card.
  await jarvis.requestApproval({ ...fold("Fold Sales Coach", { from: "mindset" }), runId: "r3" });
  assert.equal((await store.approvals.list("pending")).length, 2);
});
