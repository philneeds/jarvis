import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, getAgentConfig, setAgentConfig, CHARTERS, effectiveTools } from "../src/index.js";

test("charter tools are the floor: a tool added to the charter later reaches an agent whose settings were saved before", async () => {
  const store = memoryStore(); await store.init();
  // Stella's settings as saved on Nov 4, before GoHighLevel was in her charter.
  await store.settings.set("agentcfg:stella", { model: null, rules: { autoApprove: ["record"], maxAutoDollars: 0 }, tools: ["gmail_search", "gmail_read"], persona: {}, schedule: null });
  const cfg = await getAgentConfig(store, "stella");
  for (const t of CHARTERS.stella!.tools!) assert.ok(cfg.tools.includes(t), `${t} should be on`);
  assert.deepEqual(cfg.toolsOff, []);
});

test("a charter tool Phil switches off stays off; one he adds stays on; a tool he never saw is not off", async () => {
  const store = memoryStore(); await store.init();
  const charter = CHARTERS.karol!.tools!;
  // Phil saves Karol's list without ghl_conversations and with web_search added.
  const want = [...charter.filter((t) => t !== "ghl_conversations"), "web_search"];
  const saved = await setAgentConfig(store, "karol", { tools: want });
  assert.deepEqual(saved.toolsOff, ["ghl_conversations"]);
  assert.ok(!saved.tools.includes("ghl_conversations"));
  assert.ok(saved.tools.includes("web_search"));
  // A later save of the persona alone leaves the tool choice as it was.
  const again = await setAgentConfig(store, "karol", { persona: { job: "Find leads." } });
  assert.deepEqual(again.toolsOff, ["ghl_conversations"]);
  assert.ok(again.tools.includes("web_search"));
  // A charter tool that didn't exist when Phil saved (simulated: not in his list and not in toolsOff) is on.
  assert.ok(effectiveTools("karol", { tools: ["memory_search"], toolsOff: ["ghl_contact"] }).includes("ghl_conversations"));
  assert.ok(!effectiveTools("karol", { tools: ["memory_search"], toolsOff: ["ghl_contact"] }).includes("ghl_contact"));
});

test("saving rules or persona never freezes the tool list; only Phil's own additions and removals are stored", async () => {
  const { memoryStore, setAgentConfig, getAgentConfig, CHARTERS } = await import("../src/index.js");
  const store = memoryStore(); await store.init();
  await setAgentConfig(store, "karol", { rules: { autoApprove: [], maxAutoDollars: 50 } });
  const raw = await store.settings.get<{ tools?: string[]; toolsOff?: string[] }>("agentcfg:karol", {});
  assert.equal(raw.tools, undefined, "a rules-only save stores no tool list");
  const charter = CHARTERS.karol!.tools!;
  await setAgentConfig(store, "karol", { tools: [...charter.filter((t) => t !== "web_search"), "github_repos"] });
  const raw2 = await store.settings.get<{ tools?: string[]; toolsOff?: string[] }>("agentcfg:karol", {});
  assert.deepEqual(raw2.tools, ["github_repos"], "only the addition");
  assert.deepEqual(raw2.toolsOff, ["web_search"], "only the removal");
  await setAgentConfig(store, "karol", { persona: { job: "x" } });
  const cfg = await getAgentConfig(store, "karol");
  assert.ok(cfg.tools.includes("github_repos") && !cfg.tools.includes("web_search"), "a persona save keeps both");
});
