import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, GoogleConnector, XConnector, SpotifyConnector, readSealedSetting, writeSealedSetting, isSealedValue } from "../src/index.js";

const T0 = Date.parse("2026-11-25T15:00:00Z");
const withSecret = async <T>(secret: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const was = { p: process.env.HQ_PASSWORD, k: process.env.HQ_SECRETS_KEY, s: process.env.HQ_SESSION_SECRET };
  delete process.env.HQ_SECRETS_KEY; delete process.env.HQ_SESSION_SECRET;
  if (secret === undefined) delete process.env.HQ_PASSWORD; else process.env.HQ_PASSWORD = secret;
  try { return await fn(); } finally {
    for (const [k, v] of [["HQ_PASSWORD", was.p], ["HQ_SECRETS_KEY", was.k], ["HQ_SESSION_SECRET", was.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
/** Nothing a token could be read from: the row is ciphertext and no token text appears anywhere in it. */
const sealedRow = async (store: ReturnType<typeof memoryStore>, key: string, ...secrets: string[]) => {
  const raw = await store.settings.get<unknown>(key, null);
  assert.ok(isSealedValue(raw), `${key} is sealed`);
  for (const s of secrets) assert.ok(!JSON.stringify(raw).includes(s), `${key} doesn't hold ${s}`);
};

test("Google: a list saved before sealing is read as it was and sealed in place; the old single-account row is moved and cleared", () => withSecret("pw-1", async () => {
  const store = memoryStore(); await store.init();
  await store.settings.set("google.accounts", [{ email: "one@example.com", access_token: "ya29.PLAIN", refresh_token: "1//REFRESH", expires_at: T0 + 3_600_000, connectedAt: "2026-11-01T00:00:00Z" }]);
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", now: () => T0 });
  assert.deepEqual((await g.status()).accounts.map((a) => a.email), ["one@example.com"]);
  await sealedRow(store, "google.accounts", "ya29.PLAIN", "1//REFRESH", "one@example.com");
  assert.equal(await g.accessToken(), "ya29.PLAIN", "and it still opens");

  const old = memoryStore(); await old.init();
  await old.settings.set("google.tokens", { email: "legacy@example.com", access_token: "ya29.OLD", refresh_token: "1//OLD", expires_at: T0 + 60_000 });
  const g2 = new GoogleConnector(old, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", now: () => T0 });
  assert.equal((await g2.status()).email, "legacy@example.com");
  await sealedRow(old, "google.accounts", "ya29.OLD", "1//OLD");
  assert.equal(await old.settings.get("google.tokens", null), null, "the plain single-account row isn't left behind");
}));

test("Google: a sign-in sealed under a secret HQ no longer has says so, and is never written over as though it were empty", () => withSecret("pw-1", async () => {
  const store = memoryStore(); await store.init();
  await writeSealedSetting(store, "google.accounts", [{ email: "one@example.com", access_token: "a", refresh_token: "r", expires_at: T0 + 60_000 }]);
  const before = await store.settings.get<unknown>("google.accounts", null);
  await withSecret("pw-CHANGED", async () => {
    const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", now: () => T0 });
    const s = await g.status();
    assert.equal(s.connected, false);
    assert.match(s.problem!, /can't be opened .*HQ_PASSWORD or HQ_SECRETS_KEY.*connect again/);
    await assert.rejects(g.accessToken(), /^Error: Google: the saved sign-in can't be opened/);
    await assert.rejects(g.check(), /Google: the saved sign-in can't be opened/);
    assert.deepEqual(await store.settings.get<unknown>("google.accounts", null), before, "untouched: the right secret back in .env opens it again");
  });
  assert.equal((await readSealedSetting<{ email: string }[]>(store, "google.accounts")).value![0]!.email, "one@example.com");
}));

test("X and Spotify: saved sealed, renewed sealed, plain rows sealed on first read, cleared on disconnect", () => withSecret("pw-1", async () => {
  const store = memoryStore(); await store.init();
  await store.settings.set("x.accounts", [{ handle: "phil", userId: "1", access_token: "X-OLD", refresh_token: "X-R", expires_at: T0 - 1, connectedAt: "2026-11-01T00:00:00Z" }]);
  const xf = (async () => Response.json({ access_token: "X-NEW", refresh_token: "X-R2", expires_in: 7200 })) as typeof fetch;
  const x = new XConnector(store, { clientId: "cid", redirectUri: "http://hq/x", fetch: xf, now: () => T0 });
  assert.match(await x.check(), /@phil: session good for 119 more minutes/);
  await sealedRow(store, "x.accounts", "X-OLD", "X-NEW", "X-R2");
  assert.equal((await x.accounts())[0]!.access_token, "X-NEW");
  await x.disconnect("phil");
  assert.deepEqual(await x.accounts(), []);

  await store.settings.set("spotify.tokens", { access_token: "SP-OLD", refresh_token: "SP-R", expires_at: T0 - 1, connectedAt: "2026-11-01T00:00:00Z", name: "Phil" });
  const sf = (async (url: string | URL | Request) => (String(url).includes("/api/token") ? Response.json({ access_token: "SP-NEW", expires_in: 3600 }) : Response.json({ display_name: "Phil" }))) as typeof fetch;
  const sp = new SpotifyConnector(store, { clientId: "c", clientSecret: "s", redirectUri: "http://hq/s", fetch: sf, now: () => T0 });
  assert.equal(await sp.check(), "Signed in as Phil.");
  await sealedRow(store, "spotify.tokens", "SP-OLD", "SP-NEW", "SP-R");
  assert.deepEqual(await sp.status(), { connected: true, name: "Phil", connectedAt: "2026-11-01T00:00:00Z" });
  await withSecret("other", async () => assert.match((await sp.status()).problem ?? "", /can't be opened/));
  await sp.disconnect();
  assert.equal(await store.settings.get("spotify.tokens", null), null);
}));

test("an open dev HQ with no server secret keeps working: nothing to seal with, so rows stay as they are", () => withSecret(undefined, async () => {
  const store = memoryStore(); await store.init();
  await writeSealedSetting(store, "spotify.tokens", { access_token: "a" });
  assert.deepEqual(await store.settings.get("spotify.tokens", null), { access_token: "a" });
  assert.deepEqual(await readSealedSetting(store, "spotify.tokens"), { value: { access_token: "a" }, present: true, locked: false });
}));

test("review, Nov 27: X renews an account once however many ask at once, and never writes back another account's spent token", () => withSecret("pw-1", async () => {
  const store = memoryStore(); await store.init();
  const acct = (handle: string, userId: string) => ({ handle, userId, access_token: `old-${handle}`, refresh_token: `r-${handle}`, expires_at: T0 - 1, connectedAt: "2026-11-01T00:00:00Z" });
  await store.settings.set("x.accounts", [acct("a", "1"), acct("b", "2")]);
  const spent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const xf = (async (_url: string | URL | Request, init?: RequestInit) => {
    const token = new URLSearchParams(String(init?.body)).get("refresh_token")!;
    // X's refresh tokens work once.
    if (spent.includes(token)) return new Response("{}", { status: 400 });
    spent.push(token);
    if (token === "r-a") await gate; // @a's renewal is still at X while @b's finishes
    return Response.json({ access_token: `new-${token}`, refresh_token: `${token}-2`, expires_in: 7200 });
  }) as typeof fetch;
  const x = new XConnector(store, { clientId: "cid", redirectUri: "http://hq/x", fetch: xf, now: () => T0 });
  const priv = x as unknown as { account(h?: string): Promise<{ access_token: string }> };
  // Two callers for @a at once (an agent and the watch), and one for @b.
  const a1 = priv.account("a"), a2 = priv.account("a"), b = priv.account("b");
  assert.equal((await b).access_token, "new-r-b");
  release();
  assert.deepEqual([(await a1).access_token, (await a2).access_token], ["new-r-a", "new-r-a"], "one renewal, shared");
  assert.deepEqual(spent.sort(), ["r-a", "r-b"]);
  const saved = await x.accounts();
  assert.deepEqual(saved.map((s) => `${s.handle}:${s.refresh_token}`), ["a:r-a-2", "b:r-b-2"], "@b's new token survived @a's later write");
}));

test("review, Nov 27: a Robinhood sign-in that can't be opened is a problem to tell Phil about, not \"never connected\"", () => withSecret("pw-1", async () => {
  const { RobinhoodConnector } = await import("../src/index.js");
  const store = memoryStore(); await store.init();
  const rh = new RobinhoodConnector(store, { redirectUri: "http://x/cb", fetch: (async () => { throw new Error("no network"); }) as typeof fetch });
  assert.deepEqual([(await rh.status()).connected, (await rh.status()).problem], [false, undefined]);
  await writeSealedSetting(store, "robinhood.tokens", { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000, connectedAt: "2026-11-20T00:00:00Z" });
  assert.equal((await rh.status()).connected, true);
  await withSecret("pw-CHANGED", async () => {
    const s = await rh.status();
    assert.equal(s.connected, false);
    assert.match(s.problem!, /can't be opened/);
    await assert.rejects(rh.check(), /Robinhood: the saved sign-in can't be opened/);
  });
}));
