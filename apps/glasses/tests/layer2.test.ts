import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller, CARD_MS, FLUSH_MS, SILENCE_MS, QUIET_MS, type Glass } from "../src/background/controller";
import type { Card, Fetch } from "../src/shared/hq";
import { G2 } from "../src/shared/pages";
import type { AppState } from "../src/shared/channels";

const CARDS: Card[] = [
  { id: "c1", print: "p1", who: "Stella", title: "Book Myra Morgan Thursday 2pm", text: "Adds the appointment.", approvable: true },
  { id: "c2", print: "p2", who: "Pentoshi", title: "Buy $50 of ETH", text: "A market order.", approvable: false, why: "Approve it in HQ or Telegram." },
];

/** Stand-in glasses with a voice and an all-day mic, and a stand-in HQ that answers each route. */
function rig(o: { approvals?: boolean; listen?: boolean; cards?: Card[]; decide?: { status: number; error?: string }; heard?: number; replies?: unknown[] } = {}) {
  const shown: { body: string; footer: string }[] = [];
  const states: AppState[] = [];
  const said: string[] = [];
  const store = new Map<string, string>([["hq.url", "https://hq.test"], ["hq.key", "k1"]]);
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let hear: ((h: { text: string; isFinal: boolean }) => void) | undefined;
  let all: ((h: { text: string; isFinal: boolean }) => void) | undefined;
  let hushed = 0;
  const clock = { t: Date.parse("2026-11-25T15:00:00Z") };
  const opts = { approvals: o.approvals ?? true, listen: o.listen ?? false };
  const queue = [...(o.replies ?? [])];
  const ok = (j: unknown, status = 200) => ({ ok: status < 300, status, json: async () => j });
  const fetch: Fetch = async (url, init) => {
    const path = url.replace("https://hq.test/api/glasses/device/", "").split("?")[0]!;
    calls.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
    if (path === "ping") return ok({ ok: true, ...opts });
    if (path === "approvals") return opts.approvals ? ok({ cards: o.cards ?? CARDS }) : ok({ error: "Approvals from the glasses are off." }, 403);
    if (path === "decide") return o.decide ? ok({ error: o.decide.error }, o.decide.status) : ok({ status: "approved", title: "t" });
    if (path === "heard") return o.heard ? ok({ error: "off", listen: false }, o.heard) : ok({ kept: 1 });
    if (path === "ask") return ok({ id: "m1" });
    return ok(queue.shift() ?? { replies: [], done: true });
  };
  const glass: Glass = {
    display: () => G2,
    show: (body, footer) => shown.push({ body, footer }),
    clear: () => undefined,
    listen: (on) => { hear = on; return () => { hear = undefined; }; },
    hearAll: (on) => { all = on; return () => { all = undefined; }; },
    say: async (t) => { said.push(t); },
    hush: () => { hushed++; },
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); } },
    notify: (s) => states.push(s),
    fetch,
    timers: { set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
    now: () => clock.t,
  };
  const c = new Controller(glass);
  const elapse = (ms: number) => { const t = timers.find((x) => x.live && x.ms === ms); assert.ok(t, `no live ${ms} ms timer`); t.live = false; t.fn(); };
  const settle = () => new Promise((r) => setTimeout(r, 10));
  /** Hold to talk and say it. */
  const speak = async (text: string) => { c.talk(); hear?.({ text, isFinal: true }); await settle(); };
  return { c, shown, states, said, store, calls, opts, elapse, settle, speak, overhear: (text: string, isFinal = true) => all?.({ text, isFinal }), hearQ: (text: string, isFinal = false) => hear?.({ text, isFinal }), live: (ms: number) => timers.filter((x) => x.live && x.ms === ms).length, advance: (ms: number) => { clock.t += ms; }, allOn: () => !!all, hushed: () => hushed, last: () => shown[shown.length - 1]!, paths: () => calls.map((x) => x.path) };
}

test("a spoken question's answer is said aloud (the answer, not \"on it\"); a typed one isn't; the phone switch turns it off", async () => {
  const r = rig({ replies: [
    { replies: [{ id: "a", who: "Jarvis", kind: "ack", text: "Asking Stevon." }], done: false },
    { replies: [{ id: "b", who: "Stevon", kind: "final", text: "Close rate is 25%." }], done: true },
  ] });
  await r.c.init();
  await r.speak("what's my close rate");
  await r.settle();
  assert.deepEqual(r.said, ["Stevon says: Close rate is 25%."]);
  const typed = rig({ replies: [{ replies: [{ id: "x", who: "Jarvis", kind: "final", text: "Fine." }], done: true }] });
  await typed.c.init();
  await typed.c.ask("status?", false);
  assert.deepEqual(typed.said, []);
  const quiet = rig({ replies: [{ replies: [{ id: "x", who: "Jarvis", kind: "final", text: "Fine." }], done: true }] });
  await quiet.c.init();
  await quiet.c.setSpeak(false);
  assert.equal(quiet.store.get("speak"), "off");
  await quiet.speak("status");
  assert.deepEqual(quiet.said, []);
  assert.equal(quiet.c.state().speak, false);
  // A double tap cuts the voice off as well as clearing the view.
  r.c.dismiss();
  assert.equal(r.c.state().phase, "idle");
});

test("\"what needs me\" reads the cards one at a time; \"approve\" decides the one in view, by its fingerprint, and never reaches Jarvis", async () => {
  const r = rig();
  await r.c.init();
  await r.speak("Jarvis, what needs me?");
  assert.ok(!r.paths().includes("ask"), "a command for the glasses, not a question for Jarvis");
  assert.match(r.last().body, /^1\/2 Stella: Book Myra Morgan Thursday 2pm\nAdds the appointment\.$/);
  assert.equal(r.last().footer, "hold: approve / reject / next");
  assert.match(r.said.at(-1)!, /^Card 1 of 2\. Stella asks: Book Myra Morgan Thursday 2pm\. Hold to say approve, reject or next\.$/);
  await r.speak("approve it");
  const d = r.calls.find((x) => x.path === "decide")!;
  assert.deepEqual(d.body, { id: "c1", print: "p1", decision: "approved" });
  assert.ok(r.shown.some((s) => s.body === "Approved: Book Myra Morgan Thursday 2pm"));
  // On to the next one, which moves money: it can be heard and rejected here, approved only in HQ or Telegram.
  assert.match(r.last().body, /^1\/1 Pentoshi: Buy \$50 of ETH\nA market order\.\nApprove it in HQ or Telegram\.$/);
  assert.equal(r.last().footer, "hold: reject / next");
  await r.speak("approve");
  assert.equal(r.calls.filter((x) => x.path === "decide").length, 1, "nothing sent for a card the glasses can't approve");
  assert.match(r.last().body, /Approve it in HQ or Telegram/);
  await r.speak("reject");
  assert.deepEqual(r.calls.filter((x) => x.path === "decide").at(-1)!.body, { id: "c2", print: "p2", decision: "rejected" });
  assert.match(r.last().body.replace(/\n/g, " "), /Rejected: Buy \$50 of ETH\. Nothing else is waiting\./);
});

test("cards: next and a tap move on, stop clears, anything else is a question again; a card that changed runs nothing", async () => {
  const r = rig();
  await r.c.init();
  await r.speak("what's waiting");
  await r.speak("next");
  assert.match(r.last().body, /^2\/2 Pentoshi/);
  r.c.touch("single_tap");
  await r.settle();
  assert.match(r.last().body, /That was the last card\./);
  await r.speak("show me my approvals");
  assert.match(r.last().body, /^1\/2 Stella/);
  r.elapse(CARD_MS);
  assert.equal(r.c.state().phase, "idle", "a card left alone leaves the view after a minute and a half");
  await r.speak("any cards");
  await r.speak("what time is it");
  assert.ok(r.paths().includes("ask"), "not a command: it goes to Jarvis, and the cards are put away");
  assert.deepEqual(r.calls.find((x) => x.path === "ask")!.body, { text: "what time is it", spoken: true });
  // "don't approve" is not "approve".
  const careful = rig();
  await careful.c.init();
  await careful.speak("what needs me");
  await careful.speak("don't approve that");
  assert.ok(!careful.paths().includes("decide"));

  const changed = rig({ decide: { status: 409, error: "This card changed since it was read to you. Nothing ran; ask for the cards again." } });
  await changed.c.init();
  await changed.speak("what needs me");
  await changed.speak("approve");
  assert.match(changed.last().body.replace(/\n/g, " "), /^This card changed since it was read to you\. Nothing ran/);
  assert.equal(changed.c.state().phase, "reading");
});

test("approvals switched off in HQ: said plainly; nothing waiting: said plainly", async () => {
  const off = rig({ approvals: false });
  await off.c.init();
  assert.equal(off.c.state().approvals, false);
  await off.speak("what needs me");
  assert.match(off.last().body.replace(/\n/g, " "), /Approvals from the glasses are off\. Turn them on in HQ › Settings › Glasses\./);
  const none = rig({ cards: [] });
  await none.c.init();
  await none.speak("what needs me");
  assert.match(none.last().body, /Nothing is waiting on you\./);
  assert.deepEqual(none.said, ["Nothing is waiting on you."]);
});

test("all-day memory: off unless HQ says on; finished lines between questions go to HQ every two minutes; questions and Jarvis's own voice don't", async () => {
  const off = rig();
  await off.c.init();
  assert.equal(off.allOn(), false, "the mic isn't held for memory while it's off");

  const r = rig({ listen: true, replies: [{ replies: [{ id: "x", who: "Jarvis", kind: "final", text: "Noted." }], done: true }] });
  await r.c.init();
  assert.equal(r.allOn(), true);
  r.overhear("Mike said the roof is done Friday");
  r.overhear("the roof is", false);
  assert.equal(r.c.state().unsent, 1, "only finished lines");
  await r.speak("remind me about the roof");
  r.overhear("remind me about the roof"); // the same words come to the memory's listener too: it's still answering, so they're skipped only while listening
  r.elapse(FLUSH_MS);
  await r.settle();
  const sent = r.calls.filter((x) => x.path === "heard");
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0]!.body!.segments as { text: string }[]).map((s) => s.text), ["Mike said the roof is done Friday"], "the question itself isn't in the memory");
  assert.equal(r.c.state().unsent, 0);

  // Turned off in HQ: the next send is refused, the mic is let go, and nothing is kept on the phone.
  const turned = rig({ listen: true, heard: 403 });
  await turned.c.init();
  turned.overhear("something private");
  turned.elapse(FLUSH_MS);
  await turned.settle();
  assert.equal(turned.allOn(), false);
  assert.equal(turned.c.state().listen, false);
  assert.equal(turned.c.state().unsent, 0);
});

test("all-day memory: kept on the phone while HQ can't be reached, and HQ's switch is looked at again every ten minutes", async () => {
  const r = rig({ listen: false });
  await r.c.init();
  assert.equal(r.allOn(), false);
  // Phil turns it on in Settings; the glasses pick it up at the next look (a test or pairing looks at once).
  r.opts.listen = true;
  await r.c.test();
  assert.equal(r.allOn(), true);
  assert.equal(r.c.state().listen, true);
  const down = rig({ listen: true, heard: 502 });
  await down.c.init();
  down.overhear("first");
  down.elapse(FLUSH_MS);
  await down.settle();
  assert.equal(down.c.state().unsent, 1, "kept for the next try");
  assert.equal(down.allOn(), true);
  // Four more two-minute sends, then the fifth looks at HQ's switches again.
  for (let i = 0; i < 4; i++) { down.elapse(FLUSH_MS); await down.settle(); }
  assert.equal(down.calls.filter((x) => x.path === "ping").length, 2);
});

test("review, Nov 27: memory turned on in HQ starts by itself; a question ended by a pause and Jarvis's voice stay out of it", async () => {
  // Off at pairing. Phil turns it on in Settings: within ten minutes the glasses notice, with no restart and no Test press.
  const r = rig({ listen: false, replies: [{ replies: [{ id: "x", who: "Jarvis", kind: "final", text: "The roof is done Friday." }], done: true }] });
  await r.c.init();
  assert.equal(r.allOn(), false);
  r.opts.listen = true;
  for (let i = 0; i < 5; i++) { r.elapse(FLUSH_MS); await r.settle(); }
  assert.equal(r.allOn(), true);
  assert.equal(r.c.state().listen, true);
  // A question that ends on a pause: by the time its final words reach the memory's listener, the asking has begun.
  r.c.talk();
  r.hearQ("what did Mike say about the roof");
  r.elapse(SILENCE_MS);
  await r.settle();
  r.overhear("What did Mike say about the roof?");
  // The tail of Jarvis's spoken answer, heard back a moment after it stopped.
  r.overhear("The roof is done Friday.");
  assert.equal(r.c.state().unsent, 0);
  // A few seconds on, the room is the room again.
  r.advance(QUIET_MS + 1);
  r.overhear("Dana wants the invoice by Monday");
  assert.equal(r.c.state().unsent, 1);
  // Turned off again in HQ: the refusal lets the mic go, and the clock keeps looking so it can come back on.
  const off = rig({ listen: true, heard: 403 });
  await off.c.init();
  off.overhear("x y z");
  off.elapse(FLUSH_MS);
  await off.settle();
  assert.equal(off.allOn(), false);
  assert.equal(off.live(FLUSH_MS), 1, "still looking at HQ's switch");
});

test("review, Nov 27: \"approve\" heard in two parts is sent once, and the card isn't called unrun", async () => {
  const r = rig();
  await r.c.init();
  await r.speak("what needs me");
  r.c.talk();
  r.hearQ("approve");        // the words so far: a pause timer starts
  r.hearQ("approve", true);  // then the finished line
  await r.settle();
  assert.equal(r.live(SILENCE_MS), 0, "the pause timer doesn't outlive the command");
  assert.equal(r.calls.filter((x) => x.path === "decide").length, 1);
  assert.ok(!r.said.includes("Nothing ran. It's on the glasses."));
  assert.match(r.last().body, /^1\/1 Pentoshi/);
});
