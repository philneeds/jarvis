import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, glassesText, glassesReplies, pairGlasses, glassesKeyOk, glassesStatus, unpairGlasses, Jarvis, ModelRouter, mockProvider, GLASSES_HINT } from "../src/index.js";

test("replies become plain text for a small display", () => {
  const md = "## Today\n\n**Two** approvals are *waiting*:\n- `lp.schedule` for [Robak](https://x.test/a)\n- one deck\n\n| Rep | Sold |\n|---|---|\n| Marino | 8 |\n\n> note\n\n[Handed to @stevon]";
  assert.equal(glassesText(md), "Today\n\nTwo approvals are waiting:\n- lp.schedule for Robak\n- one deck\n\nRep · Sold\nMarino · 8\n\nnote");
  assert.equal(glassesText("Summary:\n\n- one\n- two\n\n> quoted\n\nEnd"), "Summary:\n\n- one\n- two\n\nquoted\n\nEnd", "blank lines between paragraphs survive");
  const msgs = [
    { id: "q", at: "", role: "phil", text: "hi" }, { id: "a", at: "", role: "jarvis", text: "**On it.**", replyTo: "q", kind: "ack" },
    { id: "b", at: "", role: "agent", agentId: "stevon", text: "Done.", replyTo: "q" }, { id: "c", at: "", role: "jarvis", text: "other", replyTo: "zzz" },
  ] as never;
  assert.deepEqual(glassesReplies(msgs, "q", (id) => (id === "stevon" ? "Stevon" : "?")), [{ id: "a", who: "Jarvis", kind: "ack", text: "On it." }, { id: "b", who: "Stevon", kind: undefined, text: "Done." }]);
});

test("the pairing key: only its hash is kept, a new one replaces it, unpairing ends it", async () => {
  const store = memoryStore(); await store.init();
  assert.equal(await glassesKeyOk(store, "anything"), false);
  const key = await pairGlasses(store);
  assert.ok(!JSON.stringify(await store.settings.get("glasses.pairing", null)).includes(key));
  assert.equal(await glassesKeyOk(store, key), true);
  assert.equal(await glassesKeyOk(store, `${key}x`), false);
  assert.ok((await glassesStatus(store)).seenAt, "last heard from is noted");
  const next = await pairGlasses(store);
  assert.equal(await glassesKeyOk(store, key), false);
  assert.equal(await glassesKeyOk(store, next), true);
  await unpairGlasses(store);
  assert.deepEqual(await glassesStatus(store), { paired: false });
});

test("asked through the glasses, Jarvis is told to answer in a few short sentences", async () => {
  const store = memoryStore(); await store.init();
  const provider = mockProvider("m");
  const prompts: string[] = [];
  provider.run = async (req) => { prompts.push(req.prompt); return { text: "Two approvals are waiting.", provider: "m", modelId: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }; };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  await (await jarvis.submit("what's waiting on me", { channel: "glasses", voice: true })).done;
  assert.ok(prompts.some((p) => p.includes(GLASSES_HINT.trim())), "the glasses hint reaches Jarvis");
  prompts.length = 0;
  await (await jarvis.submit("what's waiting on me", { channel: "hq" })).done;
  assert.ok(!prompts.some((p) => p.includes("smart glasses")), "not on other channels");
});
