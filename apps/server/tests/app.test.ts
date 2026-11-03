import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JARVIS_MOCK = "1";
process.env.HQ_PASSWORD = "open-sesame";
const { Jarvis, memoryStore } = await import("@jarvis/core");
const { createApp } = await import("../src/app.js");

const store = memoryStore();
await store.init();
const app = createApp(new Jarvis({ store }));

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`http://hq${path}`, { ...init, headers });
}

test("login gates the API", async () => {
  assert.equal((await call("/api/state")).status, 401);
  const bad = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }) });
  assert.equal(bad.status, 401);
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const state = await call("/api/state", { cookie });
  assert.equal(state.status, 200);
  const j = await state.json() as { agents: unknown[]; status: { level: string } };
  assert.equal(j.agents.length, 53);
  assert.equal(j.status.level, "green");

  const chat = await call("/api/chat", { method: "POST", cookie, body: JSON.stringify({ text: "@stella anything new?" }) });
  const cj = await chat.json() as { messages: { role: string; agentId?: string }[] };
  assert.equal(cj.messages[0]!.agentId, "stella");

  const kill = await call("/api/kill", { method: "POST", cookie, body: JSON.stringify({ scope: "all", paused: true }) });
  assert.equal(((await kill.json()) as { status: { level: string } }).status.level, "red");
  await call("/api/kill", { method: "POST", cookie, body: JSON.stringify({ scope: "all", paused: false }) });

  const act = await call("/api/activity?q=stella", { cookie });
  assert.ok(((await act.json()) as { entries: unknown[] }).entries.length > 0);
});
