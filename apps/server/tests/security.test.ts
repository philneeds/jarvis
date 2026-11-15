import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JARVIS_MOCK = "1";
process.env.HQ_PASSWORD = "open-sesame";
process.env.HQ_ORIGIN = "https://hq.example.test"; delete process.env.HQ_RP_ID;
const { Jarvis, memoryStore } = await import("@jarvis/core");
const { createApp } = await import("../src/app.js");
const { fromHq, loginWait, loginFailed, clientIp } = await import("../src/auth.js");

/** Regressions from the Nov 15 audit of the server. */
const store = memoryStore();
await store.init();
const app = createApp(new Jarvis({ store }));
const req = (path: string, init: RequestInit = {}) => app.request(`https://hq.example.test${path}`, init);
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
async function session(ip = "203.0.113.9") {
  const r = await req("/api/login", json({ password: "open-sesame" }, { "x-forwarded-for": ip }));
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0]!;
}

test("the voice endpoints need a session like everything else", async () => {
  for (const [path, init] of [["/api/tts/status", {}], ["/api/tts", json({ text: "hello" })], ["/api/tts/stt", { method: "POST", body: "x" }]] as [string, RequestInit][]) {
    assert.equal((await req(path, init)).status, 401, path);
  }
  const cookie = await session();
  assert.equal((await req("/api/tts/status", { headers: { cookie } })).status, 200);
});

test("a request that changes something is refused when it comes from another site", async () => {
  const cookie = await session();
  // The simple cross-site POST a hostile page can make: text/plain, Phil's cookie attached by the browser.
  const evil = await req("/api/kill", { method: "POST", body: JSON.stringify({ paused: true }), headers: { cookie, origin: "https://evil.sslip.io", "content-type": "text/plain" } });
  assert.equal(evil.status, 403);
  assert.equal((await store.agentState.all()).some((x) => x.paused), false, "nobody was paused");
  // HQ's own pages, and non-browser callers with no Origin, still work. Reads are never blocked.
  assert.equal((await req("/api/kill", json({ paused: false }, { cookie, origin: "https://hq.example.test" }))).status, 200);
  assert.equal((await req("/api/kill", json({ paused: false }, { cookie }))).status, 200);
  assert.equal((await req("/api/state", { headers: { cookie, origin: "https://evil.sslip.io" } })).status, 200);
  // Same host as the request is HQ even when HQ_ORIGIN names something else (a custom domain added later).
  assert.equal(fromHq("https://hq.custom.test", ["https://hq.example.test"], "hq.custom.test"), true);
  assert.equal(fromHq("https://other.sslip.io", ["https://hq.example.test"], "hq.custom.test"), false);
  assert.equal(fromHq("not a url", ["https://hq.example.test"], "hq.custom.test"), false);
  assert.equal(fromHq(undefined, []), true);
});

test("wrong passwords lock one address out for a while, not everyone", async () => {
  assert.equal(clientIp("198.51.100.1, 203.0.113.50"), "203.0.113.50");
  const bad = (ip: string) => req("/api/login", json({ password: "guess" }, { "x-forwarded-for": ip }));
  for (let i = 0; i < 8; i++) assert.equal((await bad("203.0.113.66")).status, 401);
  const locked = await bad("203.0.113.66");
  assert.equal(locked.status, 429);
  assert.match(((await locked.json()) as { error: string }).error, /too many wrong passwords/);
  // Even the right password waits out the lock from that address; another address is unaffected.
  assert.equal((await req("/api/login", json({ password: "open-sesame" }, { "x-forwarded-for": "203.0.113.66" }))).status, 429);
  await session("203.0.113.77");
  // The lock lifts after the window.
  loginFailed("a", 0); for (let i = 0; i < 8; i++) loginFailed("a", 1);
  assert.ok(loginWait("a", 2) > 0);
  assert.equal(loginWait("a", 16 * 60_000), 0);
});

test("a bad cookie or a bad limit is an ordinary refusal, not a crash", async () => {
  assert.equal((await req("/api/state", { headers: { cookie: "hq_session=abc.é" + "x".repeat(41) } })).status, 401);
  const cookie = await session("203.0.113.88");
  assert.equal((await req("/api/chat?limit=abc", { headers: { cookie } })).status, 200);
  assert.equal((await req("/api/activity?limit=-5", { headers: { cookie } })).status, 200);
});
