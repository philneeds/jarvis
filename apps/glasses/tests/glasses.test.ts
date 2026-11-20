import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller, SILENCE_MS, LINGER_MS, type Glass } from "../src/background/controller";
import { hqUrl, type Fetch } from "../src/shared/hq";
import { paginate, pageSize, wrap, G2 } from "../src/shared/pages";
import type { AppState } from "../src/shared/channels";

test("HQ's address: https, tidy, and nothing else", () => {
  assert.equal(hqUrl(" hq.example.com/ "), "https://hq.example.com");
  assert.equal(hqUrl("HTTPS://hq.134-199-206-190.sslip.io"), "https://hq.134-199-206-190.sslip.io");
  assert.equal(hqUrl("http://192.168.1.20:4000"), "http://192.168.1.20:4000", "plain http only on the local network");
  assert.throws(() => hqUrl("http://hq.example.com"), /must start with https/);
  assert.throws(() => hqUrl("https://hq.example.com/some/path"), /isn't HQ's address/);
  assert.throws(() => hqUrl(""), /isn't HQ's address/);
});

test("answers are cut into pages that fit the display, on word boundaries", () => {
  assert.deepEqual(pageSize(G2), { cols: 41, rows: 7 });
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrap("abcdefghijkl mn", 5), ["abcde", "fghij", "kl mn"], "a word longer than a line is split");
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const pages = paginate(long, G2);
  assert.ok(pages.length > 1);
  for (const p of pages) { assert.ok(p.split("\n").length <= 7); for (const l of p.split("\n")) assert.ok(l.length <= 41, l); }
  assert.equal(pages.join(" ").replace(/\n/g, " "), long, "nothing lost between pages");
  assert.deepEqual(paginate("", G2), [""]);
});

/** Stand-in glasses, phone storage, clock and HQ. */
function rig(opts: { paired?: boolean; replies?: { replies: { id: string; who: string; kind?: string; text: string }[]; done: boolean }[]; fail?: number } = {}) {
  const shown: { body: string; footer: string }[] = [];
  const states: AppState[] = [];
  const store = new Map<string, string>(opts.paired === false ? [] : [["hq.url", "https://hq.test"], ["hq.key", "k1"]]);
  const calls: { url: string; method: string; auth?: string; body?: unknown }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let hear: ((h: { text: string; isFinal: boolean }) => void) | undefined;
  let listening = 0, cleared = 0;
  const queue = [...(opts.replies ?? [{ replies: [{ id: "r1", who: "Jarvis", kind: "final", text: "You have two approvals waiting." }], done: true }])];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", auth: init?.headers?.authorization, body: init?.body ? JSON.parse(init.body) : undefined });
    if (opts.fail) return { ok: false, status: opts.fail, json: async () => ({ error: "nope" }) };
    if (url.endsWith("/ping")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.endsWith("/ask")) return { ok: true, status: 200, json: async () => ({ id: "m1" }) };
    return { ok: true, status: 200, json: async () => queue.shift() ?? { replies: [], done: true } };
  };
  const glass: Glass = {
    display: () => G2,
    show: (body, footer) => shown.push({ body, footer }),
    clear: () => { cleared++; },
    listen: (on) => { hear = on; listening++; return () => { hear = undefined; listening--; }; },
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); } },
    notify: (s) => states.push(s),
    fetch,
    timers: { set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
  };
  const c = new Controller(glass);
  /** Let the one live timer of that length run out. */
  const elapse = (ms: number) => { const t = timers.find((x) => x.live && x.ms === ms); assert.ok(t, `no live ${ms} ms timer`); t.live = false; t.fn(); };
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return { c, shown, states, store, calls, say: (text: string, isFinal = false) => hear?.({ text, isFinal }), listening: () => listening, cleared: () => cleared, elapse, settle, last: () => shown[shown.length - 1]! };
}

test("hold to talk: the words show as they're heard, go to HQ, and the answer shows in view", async () => {
  const r = rig();
  await r.c.init();
  assert.equal(r.c.state().status, "Paired with HQ");
  r.c.touch("long_press");
  assert.equal(r.c.state().phase, "listening");
  assert.deepEqual(r.last(), { body: "Listening…", footer: "" });
  r.say("what's on my");
  assert.deepEqual(r.last(), { body: "what's on my", footer: "listening…" });
  r.say("What's on my plate today?", true);
  await r.settle();
  assert.equal(r.listening(), 0, "the mic is released once the question is in");
  const ask = r.calls.find((x) => x.url.endsWith("/ask"))!;
  assert.deepEqual([ask.url, ask.method, ask.auth, ask.body], ["https://hq.test/api/glasses/device/ask", "POST", "Bearer k1", { text: "What's on my plate today?", spoken: true }]);
  assert.match(r.calls.at(-1)!.url, /\/replies\?to=m1&seen=0&wait=20$/);
  assert.deepEqual(r.last(), { body: "You have two approvals waiting.", footer: "" });
  assert.equal(r.c.state().phase, "reading");
  assert.equal(r.c.state().reply, "Jarvis: You have two approvals waiting.");
  // It leaves the view on its own, or on a double tap.
  r.elapse(LINGER_MS);
  assert.equal(r.cleared(), 1);
  assert.equal(r.c.state().phase, "idle");
});

test("a pause ends the question; \"on it\" is replaced by the answer; long answers page with a tap", async () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const r = rig({ replies: [
    { replies: [{ id: "a", who: "Jarvis", kind: "ack", text: "Asking Stevon." }], done: false },
    { replies: [{ id: "b", who: "Stevon", kind: "final", text: long }], done: true },
  ] });
  await r.c.init();
  r.c.talk();
  r.say("pull my sales numbers");
  r.elapse(SILENCE_MS);
  await r.settle();
  assert.equal(r.calls.filter((x) => x.url.endsWith("/ask")).length, 1);
  assert.ok(r.shown.some((s) => s.body === "Asking Stevon." && s.footer === "…"), "the first reply shows while the answer is on its way");
  assert.match(r.calls.at(-1)!.url, /seen=1/);
  assert.match(r.last().body, /^Stevon: word0 /);
  assert.match(r.last().footer, /^1\/\d+ · tap for more$/);
  r.c.touch("single_tap");
  assert.match(r.last().footer, /^2\//);
  r.c.touch("swipe_up");
  assert.match(r.last().footer, /^1\//);
  r.c.touch("double_tap");
  assert.equal(r.c.state().phase, "idle");
});

test("not paired, a refused key, a typed question, and HQ being unreachable", async () => {
  const none = rig({ paired: false });
  await none.c.init();
  none.c.talk();
  assert.match(none.last().body.replace(/\n/g, " "), /pair it with HQ first/);
  assert.equal(none.listening(), 0);
  // Pairing from the phone screen: kept only when HQ accepts it.
  await none.c.save("hq.test", "k9");
  assert.equal(none.c.state().status, "Paired with HQ");
  assert.equal(none.store.get("hq.url"), "https://hq.test");
  const refused = rig({ paired: false, fail: 401 });
  await refused.c.init();
  await refused.c.save("hq.test", "bad");
  assert.match(refused.c.state().status, /^Not saved: HQ didn't accept the pairing key/);
  assert.equal(refused.store.size, 0);
  assert.ok(!JSON.stringify(refused.states).includes("bad"), "the key never goes back to the screen");
  // Typed on the phone: asked as text, not as speech.
  const typed = rig();
  await typed.c.init();
  await typed.c.ask("status?", false);
  assert.deepEqual(typed.calls.find((x) => x.url.endsWith("/ask"))!.body, { text: "status?", spoken: false });
  // HQ unreachable: said in view, not silence.
  const down = rig({ fail: 502 });
  await down.c.init();
  await down.c.ask("hello", false);
  assert.match(down.last().body.replace(/\n/g, " "), /HQ said: nope/);
});
