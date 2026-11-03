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

test("agent settings round-trip and passkey registration needs a session", async () => {
  const ok = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "open-sesame" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const put = await call("/api/agents/stella/config", { method: "PUT", cookie, body: JSON.stringify({ persona: { job: "Run JD PM." }, tools: ["memory_search"], rules: { autoApprove: ["record"], maxAutoDollars: 250 }, schedule: { enabled: true, when: "daily@06:50", task: "Leads" } }) });
  assert.equal(put.status, 200);
  const get = await call("/api/agents/stella/config", { cookie });
  const j = (await get.json()) as { config: { persona: { job: string }; tools: string[]; rules: { maxAutoDollars: number } } };
  assert.equal(j.config.persona.job, "Run JD PM.");
  assert.deepEqual(j.config.tools, ["memory_search"]);
  assert.equal(j.config.rules.maxAutoDollars, 250);
  const bad = await call("/api/agents/stella/config", { method: "PUT", cookie, body: JSON.stringify({ schedule: { enabled: true, when: "whenever", task: "x" } }) });
  assert.equal(bad.status, 400);
  assert.equal((await call("/api/passkeys/register/options", { method: "POST" })).status, 401);
  const opts = await call("/api/passkeys/register/options", { method: "POST", cookie });
  assert.equal(opts.status, 200);
  assert.equal(((await opts.json()) as { rp: { id: string } }).rp.id, "localhost");
  assert.equal((await call("/api/passkeys/login/options", { method: "POST" })).status, 404);
});
