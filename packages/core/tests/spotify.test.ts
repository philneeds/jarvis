import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, SpotifyConnector, Jarvis, ModelRouter, mockProvider } from "../src/index.js";

/** A fake Spotify: records calls and answers like the post-February-2026 Web API. */
function fakeSpotify() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const method = init?.method ?? "GET";
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/token") return json({ access_token: body?.grant_type === "refresh_token" ? "fresh" : "tok", refresh_token: "r2", expires_in: 3600 });
    if (u.pathname === "/v1/me" && method === "GET") return json({ id: "phil", display_name: "Phil" });
    if (u.pathname === "/v1/me/top/artists") return json({ items: [{ name: "Drake", uri: "spotify:artist:1", genres: ["rap"] }] });
    if (u.pathname === "/v1/search") { const q = u.searchParams.get("q")!; return json({ tracks: { items: q.includes("nothing") ? [] : [{ uri: "spotify:track:AAAAAAAAAAAAAAAAAAAAAA", name: q, artists: [{ name: "X" }] }] } }); }
    if (u.pathname === "/v1/me/playlists" && method === "POST") return json({ id: "pl1", external_urls: { spotify: "https://open.spotify.com/playlist/pl1" } }, 201);
    if (u.pathname === "/v1/playlists/pl1/items" && method === "POST") return json({ snapshot_id: "s" }, 201);
    return json({ error: "unexpected " + u.pathname }, 404);
  }) as typeof fetch;
  return { f, calls };
}

test("Spotify: sign in, read taste, and a private playlist Lip makes on his own via the new endpoints", async () => {
  const store = memoryStore(); await store.init();
  const { f, calls } = fakeSpotify();
  let now = 1_000_000;
  const sp = new SpotifyConnector(store, { clientId: "id", clientSecret: "secret", redirectUri: "https://hq/cb", fetch: f, now: () => now });
  const { state, url } = sp.authUrl();
  assert.match(url, /scope=user-top-read/);
  await assert.rejects(sp.exchangeCode("c", "forged"), /unknown OAuth state/);
  await sp.exchangeCode("c", state);
  assert.deepEqual(await sp.status(), { connected: true, name: "Phil", connectedAt: (await sp.status()).connectedAt });
  const top = await sp.tools().find((t) => t.name === "spotify_top")!.handler({ type: "artists" }, { store, agentId: "lip" });
  assert.match(top, /Drake · rap/);
  // An expired token is refreshed and the rotated refresh token kept.
  now += 4_000_000;
  await sp.tools().find((t) => t.name === "spotify_top")!.handler({ type: "artists" }, { store, agentId: "lip" });
  assert.equal((await store.settings.get<{ refresh_token: string }>("spotify.tokens", { refresh_token: "" })).refresh_token, "r2");

  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("c")], grok: [mockProvider("g")] } }) });
  jarvis.addConnector(sp, SpotifyConnector.promptHint());
  const priv = await jarvis.requestApproval({ agentId: "lip", kind: "record", title: "Late night drive", body: "", payload: { action: "spotify.playlist.create", name: "Late night drive", tracks: ["spotify:track:BBBBBBBBBBBBBBBBBBBBBB", "Drake - Passionfruit", "nothing at all"] } });
  assert.equal(priv.status, "approved", "a private playlist is internal: Lip makes it himself");
  assert.match(priv.note!, /Playlist "Late night drive" made with 2 track\(s\): https:\/\/open\.spotify\.com\/playlist\/pl1\. Couldn't find: nothing at all/);
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/v1/me/playlists"), "uses POST /me/playlists");
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/v1/playlists/pl1/items"), "adds through /items");
  assert.ok(!calls.some((c) => /\/users\/.*\/playlists|\/tracks$/.test(c.path)), "never the removed endpoints");
  assert.ok(calls.filter((c) => c.path.startsWith("/v1/search")).every((c) => Number(new URL("http://x" + c.path).searchParams.get("limit")) <= 10), "search limit stays within 10");
  const pub = await jarvis.requestApproval({ agentId: "lip", kind: "record", title: "Party mix", body: "", payload: { action: "spotify.playlist.create", name: "Party mix", public: true, tracks: ["A - B"] } });
  assert.equal(pub.status, "pending", "a public playlist reaches people, so it waits for Phil");
  assert.match(pub.effect!, /public playlist "Party mix".*Anyone can see/);
});
