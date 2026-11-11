import { test } from "node:test";
import assert from "node:assert/strict";
process.env.ELEVENLABS_API_KEY = "test-key";
delete process.env.ELEVENLABS_VOICE_ID;
const { ttsRoutes, describeTtsFailure } = await import("../src/tts.js");

test("describeTtsFailure names the cause in plain words", () => {
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
