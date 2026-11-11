import { test } from "node:test";
import assert from "node:assert/strict";
process.env.ELEVENLABS_API_KEY = "test-key";
delete process.env.ELEVENLABS_VOICE_ID;
const { ttsRoutes, describeTtsFailure, clampSpeed } = await import("../src/tts.js");

test("describeTtsFailure names the cause in plain words", () => {
  // The body ElevenLabs actually sent on Nov 10 when the 10,000-credit quota ran out.
  assert.equal(describeTtsFailure(401, '{"detail":{"type":"invalid_request","code":"quota_exceeded","message":"This request exceeds your quota of 10000. You have 0 credits remaining"}}'), "ElevenLabs out of credits");
  assert.match(describeTtsFailure(401, '{"detail":{"status":"quota_exceeded"}}'), /out of credits/);
  assert.match(describeTtsFailure(402, ""), /out of credits/);
  assert.match(describeTtsFailure(401, '{"detail":{"status":"invalid_api_key"}}'), /API key/);
  assert.match(describeTtsFailure(404, '{"detail":{"status":"voice_not_found"}}'), /ELEVENLABS_VOICE_ID/);
  assert.equal(describeTtsFailure(500, ""), "ElevenLabs error 500");
});

test("a failed ElevenLabs call is reported on /status and cleared by the next success", async () => {
  let ok = false;
  const fake = (async () => ok
    ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } })
    : new Response('{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota."}}', { status: 401 })) as typeof fetch;
  const app = ttsRoutes(fake);
  const before = await (await app.request("/status")).json() as { available: boolean; voice: string; lastFailure?: unknown };
  assert.equal(before.available, true);
  assert.equal(before.voice, "onwK4e9ZLuTAKqWW03F9");
  assert.equal(before.lastFailure, undefined);

  const bad = await app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello Phil." }) });
  assert.equal(bad.status, 502);
  const j = await bad.json() as { error: string; fallback: string };
  assert.match(j.error, /out of credits/);
  assert.equal(j.fallback, "browser");
  const after = await (await app.request("/status")).json() as { lastFailure?: { status: number; detail: string } };
  assert.equal(after.lastFailure?.status, 401);

  ok = true;
  const good = await app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello Phil." }) });
  assert.equal(good.status, 200);
  const cleared = await (await app.request("/status")).json() as { lastFailure?: unknown };
  assert.equal(cleared.lastFailure, undefined);
});

test("the speed HQ asks for reaches ElevenLabs, held to its 0.7-1.2 range", async () => {
  assert.equal(clampSpeed(0.75), 0.75);
  assert.equal(clampSpeed(2), 1.2);
  assert.equal(clampSpeed(0.5), 0.7);
  assert.equal(clampSpeed(NaN), 1);
  const sent: number[] = [];
  const fake = (async (_u: unknown, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body)) as { voice_settings: { speed: number } }).voice_settings.speed);
    return new Response(new Uint8Array([1]), { status: 200 });
  }) as typeof fetch;
  const app = ttsRoutes(fake);
  const say = (body: object) => app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hi.", ...body }) });
  await say({ speed: 0.75 });
  await say({ speed: 1.75 });
  await say({});
  assert.deepEqual(sent, [0.75, 1.2, 1.2]);
});
