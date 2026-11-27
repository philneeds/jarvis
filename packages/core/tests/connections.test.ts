import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, runChecks, saveChecks, lastChecks, checksText, connectionTools, telegramCheck, xaiCheck, coinalyzeCheck, GoogleConnector, XConnector, SpotifyConnector, GOOGLE_SCOPES, Jarvis, ModelRouter, mockProvider, CHARTERS, type Probe } from "../src/index.js";

const probes: Probe[] = [
  { id: "works", name: "Works", what: "for the test", run: async () => "It answered.\nSecond line." },
  { id: "broken", name: "Broken", run: async () => { throw new Error("the key was refused"); } },
  { id: "absent", name: "Absent", off: () => "No key on the server.", run: async () => { throw new Error("must never be called"); } },
  { id: "silent", name: "Silent", run: () => new Promise<string>(() => undefined), timeoutMs: 30 },
  { id: "push", name: "Push", run: async () => ({ state: "unchecked", summary: "Set; a check would buzz the phone." }) },
];

test("every probe runs side by side and each gets its own verdict: working, the reason it isn't, not set up, no answer", async () => {
  const r = await runChecks(probes);
  assert.deepEqual(r.map((x) => `${x.id}:${x.state}`), ["works:ok", "broken:failed", "absent:off", "silent:failed", "push:unchecked"]);
  assert.equal(r[1]!.summary, "the key was refused");
  assert.equal(r[2]!.summary, "No key on the server.");
  assert.match(r[3]!.summary, /no answer in 0 seconds/);
  assert.equal(r[0]!.what, "for the test");
  // Asked for by id or by name; anything else checks nothing.
  assert.deepEqual((await runChecks(probes, { only: ["BROKEN", "Works"] })).map((x) => x.id), ["works", "broken"]);
  assert.deepEqual(await runChecks(probes, { only: ["nope"] }), []);
  // A probe whose "is it set up" question itself fails is a failure, not "not set up".
  const odd = await runChecks([{ id: "o", name: "O", off: () => { throw new Error("store down"); }, run: async () => "x" }]);
  assert.equal(odd[0]!.state, "failed");
  assert.match(odd[0]!.summary, /couldn't tell whether it is set up \(store down\)/);
});

test("what was last seen is kept per connection, in the probes' order, and one re-check doesn't lose the others", async () => {
  const store = memoryStore(); await store.init();
  const ids = probes.map((p) => p.id);
  await saveChecks(store, await runChecks(probes, { only: ["works", "broken"] }), ids);
  const fixed: Probe = { ...probes[1]!, run: async () => "Back." };
  const after = await saveChecks(store, await runChecks([fixed]), ids);
  assert.deepEqual(after.map((x) => `${x.id}:${x.state}`), ["works:ok", "broken:ok"]);
  assert.deepEqual((await lastChecks(store)).map((x) => x.id), ["works", "broken"]);
  // A connection HQ no longer has is dropped from what's kept.
  assert.deepEqual((await saveChecks(store, [], ["broken"])).map((x) => x.id), ["broken"]);
});

test("the results in words lead with what isn't working and why", async () => {
  const t = checksText(await runChecks(probes));
  assert.match(t, /^Connections checked just now: 1 working, 2 not working, 1 not set up, 1 set but not checkable\.\nNOT WORKING:\n- Broken: the key was refused\n- Silent: no answer/);
  assert.match(t, /WORKING:\n- Works: It answered\.\nSET, NOT CHECKED:\n- Push: Set;/);
  assert.match(t, /NOT SET UP:\n- Absent: No key on the server\.$/);
  assert.match(checksText([]), /No connection by that name/);
});

test("connections_check: an agent runs the same probes, the answer is kept for Settings, and Einstein has the tool", async () => {
  const store = memoryStore(); await store.init();
  const [tool] = connectionTools(() => probes);
  const t = await tool!.handler({ only: ["works", "absent"] }, { store, agentId: "einstein" });
  assert.match(t, /1 working, 0 not working, 1 not set up/);
  assert.deepEqual((await lastChecks(store)).map((x) => x.id), ["works", "absent"]);
  assert.match(await connectionTools(() => undefined)[0]!.handler({}, { store, agentId: "einstein" }), /isn't available here/);
  // In a real web: the server hands Jarvis the probes and the tool is among everyone's, on Einstein's list.
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  jarvis.connectionProbes = () => probes;
  const mine = jarvis.allTools().find((x) => x.name === "connections_check")!;
  assert.match(await mine.handler({ only: ["broken"] }, { store, agentId: "einstein" }), /NOT WORKING:\n- Broken: the key was refused/);
  assert.ok(CHARTERS.einstein!.tools!.includes("connections_check"));
});

test("Telegram: the token and the chat are both proven, nothing is sent, and the token never appears in an error", async () => {
  const TOKEN = "123:secret-token";
  const asked: string[] = [];
  const tg = (o: { me?: boolean; chat?: boolean; down?: boolean }) => (async (url: string | URL | Request, init?: RequestInit) => {
    const m = String(url).split("/").pop()!; asked.push(m);
    if (o.down) throw new Error(`connect failed to https://api.telegram.org/bot${TOKEN}/getMe`);
    if (m === "getMe") return o.me === false ? Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }) : Response.json({ ok: true, result: { username: "jarvis_bot" } });
    assert.deepEqual(JSON.parse(String(init?.body)), { chat_id: "42" });
    return o.chat === false ? Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 }) : Response.json({ ok: true, result: { first_name: "Phil" } });
  }) as typeof fetch;
  assert.equal(await telegramCheck(TOKEN, "42", tg({})), "Bot @jarvis_bot is answering and can message Phil.");
  assert.deepEqual(asked, ["getMe", "getChat"], "two reads; no sendMessage");
  await assert.rejects(telegramCheck(TOKEN, "42", tg({ me: false })), /refused the bot token; check TELEGRAM_BOT_TOKEN/);
  await assert.rejects(telegramCheck(TOKEN, "42", tg({ chat: false })), /bot @jarvis_bot works, but it can't see chat 42 \(Telegram said: Bad Request: chat not found\).*press Start/);
  await assert.rejects(telegramCheck(TOKEN, "42", tg({ down: true })), (e: Error) => /didn't answer/.test(e.message) && !e.message.includes("secret-token"));
});

test("xAI and Coinalyze: the key is asked about with a call that costs nothing, and a refusal says which key to fix", async () => {
  const seen: string[] = [];
  const xai = (status: number) => (async (url: string | URL | Request, init?: RequestInit) => { seen.push(`${String(url)} ${(init?.headers as Record<string, string>).authorization}`); return Response.json({ data: [{}, {}] }, { status }); }) as typeof fetch;
  assert.match(await xaiCheck("k1", xai(200), "https://api.x.ai/v1/chat/completions"), /xAI accepted the key \(2 models on it\)\. This check costs nothing/);
  assert.deepEqual(seen, ["https://api.x.ai/v1/models Bearer k1"], "the model list, not a chat or a search");
  await assert.rejects(xaiCheck("k1", xai(401), "https://api.x.ai/v1/chat/completions"), /xAI refused the key \(401\); check XAI_API_KEY/);

  let calls = 0;
  const cz = (status: number) => (async () => { calls++; return status === 200 ? Response.json([{ name: "Binance", code: "A" }, { name: "Bybit", code: "6" }, { name: "Tiny", code: "Z" }]) : Response.json({ message: "bad key" }, { status }); }) as typeof fetch;
  assert.equal(await coinalyzeCheck({ key: "free", fetch: cz(200) }), "Coinalyze accepted the key: 3 venues, 2 of the 8 HQ sums liquidations over (binance, bybit).");
  // Asked afresh every time: a kept answer would hide a key that stopped working a minute ago.
  await assert.rejects(coinalyzeCheck({ key: "free", fetch: cz(401) }), /Coinalyze refused the key \(bad key\)/);
  assert.equal(calls, 2);
});

test("Google: each account's sign-in is proven with Google, and a revoked one or a missing permission is named", async () => {
  const store = memoryStore(); await store.init();
  const t0 = Date.parse("2026-11-24T15:00:00Z");
  await store.settings.set("google.accounts", [
    { email: "one@example.com", access_token: "live-1", refresh_token: "r1", expires_at: t0 + 3_600_000, connectedAt: "2026-11-01T00:00:00Z" },
    { email: "two@example.com", access_token: "old-2", refresh_token: "r2", expires_at: t0 - 1000, connectedAt: "2026-11-02T00:00:00Z" },
  ]);
  const scopes = { "live-1": GOOGLE_SCOPES.join(" "), "new-2": GOOGLE_SCOPES.filter((s) => !/drive/.test(s)).join(" ") } as Record<string, string>;
  let revoked = false;
  const f = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.pathname === "/token") return revoked ? new Response("{}", { status: 400 }) : Response.json({ access_token: "new-2", expires_in: 3600 });
    const scope = scopes[u.searchParams.get("access_token") ?? ""];
    return scope ? Response.json({ scope }) : new Response("{}", { status: 400 });
  }) as typeof fetch;
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "sec", redirectUri: "http://hq/cb", fetch: f, now: () => t0 });
  // The second account's token had run out: it is renewed first, then found to lack Drive.
  await assert.rejects(g.check(), (e: Error) => /^one@example\.com: signed in; can use Calendar, Gmail, Drive \(files HQ makes\)\ntwo@example\.com: signed in; can use Calendar, Gmail\. Missing: drive\.file \(disconnect and connect again/.test(e.message));
  scopes["new-2"] = GOOGLE_SCOPES.join(" ");
  assert.match(await g.check(), /^one@example\.com: signed in;.*\ntwo@example\.com: signed in; can use Calendar, Gmail, Drive \(files HQ makes\)$/);
  // Google stops accepting a token it once gave (Phil removed HQ's access from his Google account).
  delete scopes["live-1"];
  await assert.rejects(g.check(), /one@example\.com: Google no longer accepts the sign-in \(400\); disconnect it and connect again\ntwo@example\.com: signed in/);
  revoked = true;
  await store.settings.set("google.accounts", []);
  await assert.rejects(g.check(), /No Google account is connected/);
});

test("X renews the session and reads nothing (reads are billed); Spotify is asked whose account it is", async () => {
  const store = memoryStore(); await store.init();
  const t0 = Date.parse("2026-11-24T15:00:00Z");
  await store.settings.set("x.accounts", [{ handle: "phil", userId: "1", access_token: "old", refresh_token: "r", expires_at: t0 - 1, connectedAt: "2026-11-01T00:00:00Z" }]);
  const asked: string[] = [];
  let ok = true;
  const xf = (async (url: string | URL | Request) => { asked.push(new URL(String(url)).pathname); return ok ? Response.json({ access_token: "new", refresh_token: "r2", expires_in: 7200 }) : new Response("{}", { status: 400 }); }) as typeof fetch;
  const x = new XConnector(store, { clientId: "cid", redirectUri: "http://hq/x", fetch: xf, now: () => t0 });
  assert.match(await x.check(), /^@phil: session good for 119 more minutes, and it renews itself\n\(Checked by renewing the session; nothing was read, so it cost nothing\.\)$/);
  assert.deepEqual(asked, ["/2/oauth2/token"], "the token endpoint only");
  await store.settings.set("x.accounts", [{ handle: "phil", userId: "1", access_token: "old", refresh_token: "gone", expires_at: t0 - 1, connectedAt: "2026-11-01T00:00:00Z" }]);
  ok = false;
  await assert.rejects(x.check(), /@phil: X token refresh failed for @phil: 400/);

  await store.settings.set("spotify.tokens", { access_token: "a", refresh_token: "r", expires_at: t0 + 60_000, connectedAt: "2026-11-01T00:00:00Z" });
  let status = 200;
  const sf = (async (url: string | URL | Request) => { assert.equal(new URL(String(url)).pathname, "/v1/me"); return status === 200 ? Response.json({ display_name: "Phil", product: "premium" }) : new Response("no", { status }); }) as typeof fetch;
  const sp = new SpotifyConnector(store, { clientId: "c", clientSecret: "s", redirectUri: "http://hq/s", fetch: sf, now: () => t0 });
  assert.equal(await sp.check(), "Signed in as Phil (premium).");
  status = 401;
  await assert.rejects(sp.check(), /Spotify GET \/me failed: 401/);
});

test("the watch: one that worked and fails twice in a row is told once; a blip, or one that never worked, isn't; back closes it", async () => {
  const { watchConnections, CONNECTIONS_WATCH_KEY } = await import("../src/index.js");
  const store = memoryStore(); await store.init();
  const state: Record<string, "ok" | "fail" | "off"> = { robinhood: "ok", health: "fail", kalshi: "off", google: "ok" };
  const probes: Probe[] = Object.keys(state).map((id) => ({
    id, name: id[0]!.toUpperCase() + id.slice(1),
    off: () => (state[id] === "off" ? "not set up" : undefined),
    run: async () => { if (state[id] === "fail") throw new Error(`${id} refused the sign-in`); return `${id} fine`; },
  }));
  const raised: string[] = [], resolved: string[] = [];
  const deps = { probes, store, raise: async (title: string, why: string) => { raised.push(`${title} | ${why.split("\n")[0]}`); return `item-${raised.length}`; }, resolve: async (id: string, name: string) => { resolved.push(`${id} ${name}`); } };
  const r1 = await watchConnections(deps);
  assert.deepEqual([r1.down, r1.back], [[], []]);
  assert.equal(r1.summary, "2 working, not working: Health");
  // Robinhood drops once: a blip, nothing said. Apple Health has never worked: never said, however often it fails.
  state.robinhood = "fail";
  await watchConnections(deps);
  assert.deepEqual(raised, []);
  const r3 = await watchConnections(deps);
  assert.deepEqual(raised, ["Robinhood stopped working | robinhood refused the sign-in"]);
  assert.match(r3.summary, /told Phil: Robinhood stopped/);
  // Still down: not said again.
  await watchConnections(deps);
  assert.equal(raised.length, 1);
  // A blip on Google that clears by the next check: nothing.
  state.google = "fail"; await watchConnections(deps); state.google = "ok";
  // Robinhood back: the item is closed and he hears it.
  state.robinhood = "ok";
  const r6 = await watchConnections(deps);
  assert.deepEqual(resolved, ["item-1 Robinhood"]);
  assert.deepEqual(r6.back, ["Robinhood"]);
  assert.equal(raised.length, 1);
  assert.equal((await store.settings.get<Record<string, { fails: number }>>(CONNECTIONS_WATCH_KEY, {})).health!.fails, 6);
  // Settings shows what the watch last saw.
  assert.deepEqual((await lastChecks(store)).map((x) => `${x.id}:${x.state}`), ["robinhood:ok", "health:failed", "kalshi:off", "google:ok"]);
});

test("the watch runs every three hours as housekeeping, on the Schedules screen, and says nothing in the log while all is the same", async () => {
  const { SCHEDULES, Jarvis, ModelRouter, mockProvider } = await import("../src/index.js");
  const { HOUSEKEEPING } = await import("../src/scheduler.js");
  const s = SCHEDULES.find((x) => x.id === "connections-watch")!;
  assert.equal(s.when, "every:180");
  assert.ok(HOUSEKEEPING.has(s.task));
  const store = memoryStore(); await store.init();
  const phone: string[] = [];
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }), notify: async (t, b) => { phone.push(`${t} | ${b}`); } });
  assert.equal(await jarvis.watchConnections(), undefined, "no probes wired: nothing to do");
  let up = true;
  jarvis.connectionProbes = () => [{ id: "rh", name: "Robinhood", run: async () => { if (!up) throw new Error("token expired"); return "Connected."; } }];
  assert.equal(await jarvis.watchConnections(), undefined);
  up = false;
  await jarvis.watchConnections();
  assert.match((await jarvis.watchConnections())!, /told Phil: Robinhood stopped/);
  assert.deepEqual(phone.map((p) => p.split(" | ")[0]), ["Needs you: Robinhood stopped working"]);
  assert.ok((await jarvis.attentionList()).some((i) => i.title === "Robinhood stopped working" && i.status === "open"));
  up = true;
  assert.match((await jarvis.watchConnections())!, /back: Robinhood/);
  assert.equal(phone.at(-1), "Robinhood is working again | Connected.");
  assert.ok((await jarvis.attentionList()).some((i) => i.title === "Robinhood stopped working" && i.status === "done"));
});

test("review, Nov 27: a connection that stops being set up closes its alert quietly; only one that works again is \"working again\"", async () => {
  const { watchConnections, Jarvis, ModelRouter, mockProvider } = await import("../src/index.js");
  const store = memoryStore(); await store.init();
  const phone: string[] = [];
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }), notify: async (t) => { phone.push(t); } });
  let state: "ok" | "fail" | "off" = "ok";
  jarvis.connectionProbes = () => [{ id: "g", name: "Google", off: () => (state === "off" ? "No account connected." : undefined), run: async () => { if (state === "fail") throw new Error("sign-in expired"); return "fine"; } }];
  await jarvis.watchConnections();
  state = "fail"; await jarvis.watchConnections(); await jarvis.watchConnections();
  assert.deepEqual(phone, ["Needs you: Google stopped working"]);
  // Phil disconnects the broken account: the item closes, and nobody says it works.
  state = "off"; await jarvis.watchConnections();
  assert.deepEqual(phone, ["Needs you: Google stopped working"]);
  assert.ok((await jarvis.attentionList()).some((i) => i.title === "Google stopped working" && i.status === "done"));
  void watchConnections;
});

test("review, Nov 27: results saved side by side from Settings, the watch and an agent all land", async () => {
  const store = memoryStore(); await store.init();
  // A store whose reads and writes take a moment, as the database's do.
  const slow = { settings: { get: async <T,>(k: string, d: T) => { await new Promise((r) => setTimeout(r, 5)); return store.settings.get<T>(k, d); }, set: async (k: string, v: unknown) => { await new Promise((r) => setTimeout(r, 5)); return store.settings.set(k, v); } } } as unknown as Parameters<typeof saveChecks>[0];
  const ids = ["a", "b", "c", "d"];
  const one = (id: string) => ({ id, name: id, state: "ok" as const, summary: "fine", ms: 1, at: "2026-11-27T00:00:00Z" });
  await Promise.all(ids.map((id) => saveChecks(slow, [one(id)], ids)));
  assert.deepEqual((await lastChecks(store)).map((r) => r.id), ids);
});
