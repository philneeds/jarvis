import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, RobinhoodConnector, sealJson, openJson } from "../src/index.js";

test("Robinhood's sign-in is sealed at rest: the database, backups and db_query only see ciphertext", async () => {
  const prev = process.env.HQ_SECRETS_KEY;
  process.env.HQ_SECRETS_KEY = "test-server-secret";
  try {
    const store = memoryStore(); await store.init();
    // A sign-in saved before sealing existed is sealed the first time HQ reads it.
    await store.settings.set("robinhood.tokens", { access_token: "rh-access-123456", refresh_token: "rh-refresh-abcdef", connectedAt: "2026-11-17T10:00:00Z" });
    const rh = new RobinhoodConnector(store, { redirectUri: "http://x/cb" });
    const s = await rh.status();
    assert.equal(s.connected, true);
    assert.equal(s.connectedAt, "2026-11-17T10:00:00Z");
    const raw = JSON.stringify(await store.settings.get("robinhood.tokens", null));
    assert.doesNotMatch(raw, /rh-access|rh-refresh/, "what's stored is ciphertext");
    assert.match(raw, /aes-256-gcm/);
    // Round trip, and a different server secret can't open it.
    const sealed = sealJson({ a: "secret-value" });
    assert.deepEqual(openJson(sealed), { a: "secret-value" });
    assert.equal(openJson(sealed, { HQ_SECRETS_KEY: "another-secret" }), undefined);
    await rh.disconnect();
    assert.equal((await rh.status()).connected, false);
  } finally {
    if (prev === undefined) delete process.env.HQ_SECRETS_KEY; else process.env.HQ_SECRETS_KEY = prev;
  }
});
