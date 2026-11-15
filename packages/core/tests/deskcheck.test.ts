import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider } from "../src/index.js";

/**
 * The desk check: a small model compares each new card with the ones waiting and the ones Phil just decided, so he is
 * never asked the same thing twice. The model here is a stand-in that answers from a script.
 */
function make(answer: (prompt: string) => string | undefined) {
  const store = memoryStore();
  const provider = mockProvider("mock");
  const base = provider.run.bind(provider);
  const checks: { model: string; prompt: string }[] = [];
  provider.run = async (req) => {
    if (/^NEW card:/.test(req.prompt)) {
      checks.push({ model: req.model.key, prompt: req.prompt });
      const text = answer(req.prompt);
      if (text === undefined) throw new Error("model not available");
      return { text, provider: "mock", modelId: req.model.modelId ?? "m", inputTokens: 10, outputTokens: 5, costUsd: 0, durationMs: 1 };
    }
    return base(req);
  };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  return { store, jarvis, checks };
}
const idOf = (prompt: string, title: string) => new RegExp(`^([0-9a-f]{8}) \\| [^\\n]*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").exec(prompt)?.[1];
const fold = (agentId: string, title: string, action: string, runId: string, kind: "config" | "strategy" = "config") => ({ agentId, kind, title, body: `${title}. Details follow.`, payload: { action }, runId });

test("two cards in one reply for the same decision: the fuller one is kept, whichever came first", async () => {
  // The model says the combined card covers the single one.
  const { jarvis, store, checks } = make((p) => {
    const single = idOf(p, "Sunset Sales Coach, fold into Stevon");
    const both = idOf(p, "Sunset Sales Coach + Mindset Coach");
    if (/^NEW card:\n[^\n]*Sunset Sales Coach, fold into Stevon/.test(p) && both) return JSON.stringify({ same: [{ id: both, keep: "old" }], why: "the combined card already includes Sales Coach" });
    if (/^NEW card:\n[^\n]*Sunset Sales Coach \+ Mindset Coach/.test(p) && single) return `Here you go: ${JSON.stringify({ same: [{ id: single, keep: "new" }], why: "the new card covers both coaches" })}`;
    return JSON.stringify({ same: [] });
  });
  // Combined first, then its part (same run): the part isn't put in front of Phil.
  const combined = await jarvis.requestApproval(fold("oscar", "Sunset Sales Coach + Mindset Coach, fold both into Stevon", "agents.sunset_fold", "r1", "strategy"));
  const part = await jarvis.requestApproval(fold("oscar", "Sunset Sales Coach, fold into Stevon", "agent.fold", "r1"));
  assert.equal(part.id, combined.id, "the caller is handed the card that's already waiting");
  let pending = await store.approvals.list("pending");
  assert.deepEqual(pending.map((p) => p.title), ["Sunset Sales Coach + Mindset Coach, fold both into Stevon"]);
  assert.ok((await store.approvals.list()).some((a) => /^superseded: already covered by "Sunset Sales Coach \+ Mindset Coach/.test(a.note ?? "")));
  assert.ok(checks.every((c) => c.model === "claude-haiku"), "the small model does the checking");
  assert.equal((await store.agentState.get("jarvis"))?.status ?? "idle", "idle", "and Jarvis isn't shown as working or in error for it");
  // The other order, with a fresh store: the part first, then the combined card replaces it.
  const b = make((p) => { const single = idOf(p, "Sunset Sales Coach, fold into Stevon"); return single ? JSON.stringify({ same: [{ id: single, keep: "new" }], why: "covers both" }) : JSON.stringify({ same: [] }); });
  await b.jarvis.requestApproval(fold("oscar", "Sunset Sales Coach, fold into Stevon", "agent.fold", "r1"));
  const c2 = await b.jarvis.requestApproval(fold("oscar", "Sunset Sales Coach + Mindset Coach, fold both into Stevon", "agents.sunset_fold", "r1", "strategy"));
  pending = await b.store.approvals.list("pending");
  assert.deepEqual(pending.map((p) => p.id), [c2.id]);
  assert.match(c2.effect ?? "", /Replaces the older card: "Sunset Sales Coach, fold into Stevon"/);
});

test("two agents proposing the same thing: Phil gets the one that does it", async () => {
  const { jarvis, store } = make((p) => { const ship = idOf(p, "Retire Sales Coach"); return ship ? JSON.stringify({ same: [{ id: ship, keep: "new" }], why: "same roster change" }) : JSON.stringify({ same: [] }); });
  let did = 0;
  jarvis.addConnector({ tools: () => [], executors: () => ({ "roster.change": async () => { did++; return "done"; } }) } as never);
  const real = await jarvis.requestApproval({ agentId: "einstein", kind: "config", title: "Retire Sales Coach and fold it into Stevon", body: "does it", payload: { action: "roster.change" }, runId: "e1" });
  // Oscar proposes the same thing as a card that would only record the decision. The model even prefers the new one.
  const note = await jarvis.requestApproval(fold("oscar", "Sunset Sales Coach, fold into Stevon", "agent.fold", "o1"));
  assert.equal(note.id, real.id, "the card that does it stays; the record-only repeat isn't filed");
  assert.deepEqual((await store.approvals.list("pending")).map((p) => p.id), [real.id]);
  assert.equal(did, 0);
});

test("a repeat of something Phil already decided says so on the card", async () => {
  const { jarvis } = make((p) => { const old = idOf(p, "Fold Mindset Coach into Stevon"); return old && /Cards Phil DECIDED/.test(p) ? JSON.stringify({ same: [{ id: old, keep: "new" }], why: "same fold" }) : JSON.stringify({ same: [] }); });
  const first = await jarvis.requestApproval(fold("oscar", "Fold Mindset Coach into Stevon", "agents.fold", "o1"));
  await jarvis.decide(first.id, "approved");
  let ships = 0;
  jarvis.addConnector({ tools: () => [], executors: () => ({ "roster.change": async () => { ships++; return "done"; } }) } as never);
  const second = await jarvis.requestApproval({ agentId: "einstein", kind: "config", title: "Mindset Coach becomes a Stevon skill", body: "the code for it", payload: { action: "roster.change" }, runId: "e1" });
  assert.equal(second.status, "pending");
  assert.match(second.effect ?? "", /You approved a card like this on \w+ \d+: "Fold Mindset Coach into Stevon" \(Oscar\)\. That one only recorded your decision; this one does it\./);
});

test("the check never loses a card: no answer, a wrong id, different decisions, money", async () => {
  // The small model is missing: the next one up is asked; if that fails too, the card is simply filed.
  const down = make(() => undefined);
  await down.jarvis.requestApproval(fold("oscar", "Card one", "x.one", "r1"));
  const two = await down.jarvis.requestApproval(fold("oscar", "Card two", "x.two", "r2"));
  assert.equal(two.status, "pending");
  assert.equal((await down.store.approvals.list("pending")).length, 2);
  assert.deepEqual(down.checks.map((c) => c.model), ["claude-haiku", "claude-sonnet"], "one check, tried on both models");
  assert.notEqual((await down.store.agentState.get("jarvis"))?.status, "error", "a failed check doesn't put Jarvis in error");
  // Not JSON, an id that isn't on the list, or "nothing matches": both cards wait.
  for (const reply of ["I think these are different.", JSON.stringify({ same: [{ id: "deadbeef", keep: "old" }] }), JSON.stringify({ same: [] })]) {
    const x = make(() => reply);
    await x.jarvis.requestApproval(fold("stella", "Email Tracy about the roof", "note.a", "r1"));
    await x.jarvis.requestApproval(fold("stella", "Email Howard about the siding", "note.b", "r2"));
    assert.equal((await x.store.approvals.list("pending")).length, 2, reply);
  }
  // A money card is never dropped on the model's say-so, and never replaced by a card that isn't money.
  const m = make((p) => { const old = idOf(p, "Pay the coach"); return old ? JSON.stringify({ same: [{ id: old, keep: /^NEW card:\n[^\n]*plan/i.test(p) ? "new" : "old" }], why: "same" }) : JSON.stringify({ same: [] }); });
  const pay = await m.jarvis.requestApproval({ agentId: "david", kind: "money", title: "Pay the coach $400", body: "x", payload: { action: "payment.send", amount: 400 }, runId: "r1" });
  const pay2 = await m.jarvis.requestApproval({ agentId: "david", kind: "money", title: "Pay the coach $400 again", body: "y", payload: { action: "payment.send", amount: 400 }, runId: "r2" });
  assert.notEqual(pay2.id, pay.id);
  assert.equal((await m.store.approvals.list("pending")).length, 2, "both money cards stay in front of Phil");
  const plan = await m.jarvis.requestApproval(fold("david", "New coaching plan", "plan.propose", "r3"));
  assert.equal((await m.store.approvals.get(pay.id))?.status, "pending");
  assert.match(plan.effect ?? "", /Overlaps "Pay the coach \$400"/);
  // Turned off, nothing is asked.
  process.env.DESK_CHECK = "off";
  try { const off = make(() => { throw new Error("should not be asked"); }); await off.jarvis.requestApproval(fold("oscar", "A", "x.a", "r1")); await off.jarvis.requestApproval(fold("oscar", "B", "x.b", "r2")); assert.equal(off.checks.length, 0); }
  finally { delete process.env.DESK_CHECK; }
});

test("Einstein's Ship card takes the place of a record-only card for the same change, and is never the one dropped", async () => {
  const { jarvis, store } = make((p) => {
    const note = idOf(p, "Sunset Mindset Coach, fold into Stevon"), ship = idOf(p, "Ship: fold Mindset Coach into Stevon");
    if (/^NEW card:\n[^\n]*Ship: fold Mindset/.test(p) && note) return JSON.stringify({ same: [{ id: note, keep: "old" }], why: "same fold" }); // the model gets it backwards
    if (ship) return JSON.stringify({ same: [{ id: ship, keep: "new" }], why: "same fold" });
    return JSON.stringify({ same: [] });
  });
  jarvis.addConnector({ tools: () => [], executors: () => ({ "code.ship": async () => "shipped" }) } as never);
  const note = await jarvis.requestApproval(fold("oscar", "Sunset Mindset Coach, fold into Stevon", "agent.fold", "o1", "strategy"));
  const ship = await jarvis.requestApproval({ agentId: "einstein", kind: "config", title: "Ship: fold Mindset Coach into Stevon", body: "the code", payload: { action: "code.ship", sha: "abc1234" }, runId: "e1" });
  assert.equal(ship.status, "pending", "a ship card is never dropped as a repeat, whatever the model says");
  assert.notEqual(ship.id, note.id);
  // Oscar proposes it once more as a record-only card: the Ship card already asks Phil, so it isn't filed.
  const again = await jarvis.requestApproval(fold("oscar", "Fold Mindset into Stevon (roster)", "agent.fold", "o2", "strategy"));
  assert.equal(again.id, ship.id);
  assert.ok((await store.approvals.list("pending")).some((p) => p.id === ship.id));
});
