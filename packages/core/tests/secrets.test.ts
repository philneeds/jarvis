import { test } from "node:test";
import assert from "node:assert/strict";
import { Secrets, NO_SEALING_KEY, UNSEAL_FAILED, settingKeyFor, memoryStore } from "../src/index.js";

const KEY = "AIzaSyExample-Key_0123456789abcdefghijk";

test("a key saved in Settings is sealed in the store: ciphertext at rest, the value only in memory, and .env still wins", async () => {
  const store = memoryStore(); await store.init();
  const s = new Secrets(store, { HQ_PASSWORD: "open-sesame" }, () => new Date("2026-11-16T03:30:00Z"));
  assert.equal(s.canSave(), true);
  assert.deepEqual(s.status("GEMINI_API_KEY"), { set: false, source: "none" });
  await s.set("GEMINI_API_KEY", `  ${KEY}\n`);
  assert.equal(s.get("GEMINI_API_KEY"), KEY, "trimmed, and readable in this process");
  assert.deepEqual(s.status("GEMINI_API_KEY"), { set: true, source: "settings", savedAt: "2026-11-16T03:30:00.000Z" });

  // What a database dump, a backup or db_query would show.
  const raw = await store.settings.get<Record<string, string> | null>(settingKeyFor("GEMINI_API_KEY"), null);
  assert.ok(raw && raw.alg === "aes-256-gcm" && raw.iv && raw.tag && raw.data);
  assert.ok(!JSON.stringify(raw).includes(KEY), "the key never sits in the store in clear");
  assert.ok(!JSON.stringify(raw).includes(Buffer.from(KEY).toString("base64")), "nor merely encoded");

  // A fresh process with the same server secret reads it back; one with a changed secret says so instead of guessing.
  const again = new Secrets(store, { HQ_PASSWORD: "open-sesame" });
  await again.load();
  assert.equal(again.get("GEMINI_API_KEY"), KEY);
  const changed = new Secrets(store, { HQ_PASSWORD: "something-else" });
  await changed.load();
  assert.equal(changed.get("GEMINI_API_KEY"), undefined);
  assert.deepEqual(changed.status("GEMINI_API_KEY"), { set: false, source: "none", problem: UNSEAL_FAILED });
  // Saving again under the new secret clears the problem.
  await changed.set("GEMINI_API_KEY", "AIzaNewKey_abcdefghijklmnop");
  assert.deepEqual(changed.status("GEMINI_API_KEY").problem, undefined);
  assert.equal(changed.get("GEMINI_API_KEY"), "AIzaNewKey_abcdefghijklmnop");

  // The server's own .env entry wins (the reader puts it first), so Settings refuses to keep a second one that would be dead weight.
  const env = new Secrets(store, { HQ_PASSWORD: "something-else", GEMINI_API_KEY: "from-env" });
  await env.load();
  assert.equal(env.get("GEMINI_API_KEY"), "AIzaNewKey_abcdefghijklmnop", "what is saved, never the environment");
  await assert.rejects(env.set("GEMINI_API_KEY", KEY), /set in \/opt\/jarvis\/\.env on the server, and that one wins/);

  // Removing forgets it everywhere.
  await changed.clear("GEMINI_API_KEY");
  assert.equal(changed.get("GEMINI_API_KEY"), undefined);
  assert.equal(await store.settings.get(settingKeyFor("GEMINI_API_KEY"), "gone"), null);
});

test("without a server secret nothing can be sealed, and what Phil pastes is checked for shape before it is kept", async () => {
  const store = memoryStore(); await store.init();
  const open = new Secrets(store, {});
  assert.equal(open.canSave(), false);
  await assert.rejects(open.set("GEMINI_API_KEY", KEY), new RegExp(NO_SEALING_KEY.slice(0, 40)));
  assert.equal(await store.settings.get(settingKeyFor("GEMINI_API_KEY"), null), null, "nothing written in clear as a fallback");

  const s = new Secrets(store, { HQ_SECRETS_KEY: "a-dedicated-secret" });
  await assert.rejects(s.set("GEMINI_API_KEY", "   "), /the key is empty/);
  await assert.rejects(s.set("GEMINI_API_KEY", "AIza two words"), /spaces or line breaks/);
  await assert.rejects(s.set("GEMINI_API_KEY", "x".repeat(401)), /too long/);
  assert.equal(s.get("GEMINI_API_KEY"), undefined);
  // HQ_SECRETS_KEY is preferred over the login secrets when both exist, so a password change doesn't lock keys away.
  const both = new Secrets(store, { HQ_SECRETS_KEY: "a-dedicated-secret", HQ_PASSWORD: "pw1" });
  await both.set("GEMINI_API_KEY", KEY);
  const newPw = new Secrets(store, { HQ_SECRETS_KEY: "a-dedicated-secret", HQ_PASSWORD: "pw2" });
  await newPw.load();
  assert.equal(newPw.get("GEMINI_API_KEY"), KEY);
});
