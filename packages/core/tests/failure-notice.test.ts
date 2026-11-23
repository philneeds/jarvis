import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, Scheduler, memoryStore, mockProvider, type Schedule } from "../src/index.js";

/** A web whose model fails the way it's told to, and a record of what reached Phil's phone. */
async function rig(fail: (prompt: string) => string | undefined) {
  const store = memoryStore(); await store.init();
  await store.settings.set("phase", 3);
  const base = mockProvider("mock-claude");
  const provider = { ...base, async run(req: Parameters<typeof base.run>[0]) { const why = fail(req.prompt); if (why) throw new Error(why); return base.run(req); } };
  const phone: string[] = [];
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }), notify: async (title, body) => { phone.push(`${title} | ${body}`); } });
  return { store, jarvis, phone };
}
const at = new Date(2026, 10, 23, 21, 0); // Monday 9 pm
const deck: Schedule = { id: "stevon-weekly", agentId: "stevon", task: "Build the deck", when: "weekly:mon@21:00", phase: 1, push: true };
const scout: Schedule = { id: "karol-leads", agentId: "karol", task: "New lead check", when: "every:30", phase: 1 };

test("a deliverable Phil is waiting on that fails reaches his phone, once, and says what to do", async () => {
  const { jarvis, phone } = await rig((p) => (/Build the deck/.test(p) ? "LeadPerfection timed out" : undefined));
  const s = new Scheduler(jarvis, [deck]);
  await s.tick(at);
  const mine = phone.filter((x) => /didn't run/.test(x));
  assert.equal(mine.length, 1);
  assert.match(mine[0]!, /^Needs you: Stevon's Tuesday meeting deck didn't run \| .*LeadPerfection timed out.*Ask Stevon to run it again/);
  const open = (await jarvis.attentionList()).filter((i) => i.status !== "done");
  assert.ok(open.some((i) => /Stevon's Tuesday meeting deck didn't run/.test(i.title)), "and it is on Needs you");
  // The same failure a week later, still unticked, is the same one line: no second alert.
  await new Scheduler(jarvis, [deck]).tick(new Date(2026, 10, 30, 21, 0));
  assert.equal(phone.filter((x) => /didn't run/.test(x)).length, 1);
});

test("a routine that reports up the chain: a real failure is told once; the plan's usage limit and a pause are not", async () => {
  const real = await rig((p) => (/New lead check/.test(p) ? "socket hang up" : undefined));
  const s = new Scheduler(real.jarvis, [scout]);
  await s.tick(at);
  await s.tick(new Date(at.getTime() + 31 * 60_000));
  const told = real.phone.filter((x) => /routine failed/.test(x));
  assert.equal(told.length, 1, "one line while it stays open, not one per half hour");
  assert.match(told[0]!, /Needs you: Karol's routine failed: karol-leads \| .*socket hang up/);

  const limit = await rig((p) => (/New lead check/.test(p) ? "Claude usage limit reached; resets at 11pm" : undefined));
  await new Scheduler(limit.jarvis, [scout]).tick(at);
  assert.equal(limit.phone.filter((x) => /routine failed|didn't run/.test(x)).length, 0, "the limit is already said once for everything that waits on it");

  // A deliverable is different: Phil is waiting on it, so even the limit is worth a line.
  const deckLimit = await rig((p) => (/Build the deck/.test(p) ? "Claude usage limit reached; resets at 11pm" : undefined));
  await new Scheduler(deckLimit.jarvis, [deck]).tick(at);
  assert.equal(deckLimit.phone.filter((x) => /Stevon's Tuesday meeting deck didn't run/.test(x)).length, 1);

  const fine = await rig(() => undefined);
  await new Scheduler(fine.jarvis, [scout]).tick(at);
  assert.equal(fine.phone.filter((x) => /routine failed|didn't run/.test(x)).length, 0, "nothing to say when it worked");
});
