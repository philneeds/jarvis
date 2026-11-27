import { z } from "zod";
import { defineTool, type ToolDef } from "./tools/index.js";
import type { Store } from "./store/types.js";

/**
 * One check for every connection (Phil, Nov 24 2026: the Robinhood sign-in took three rounds of screenshots to
 * diagnose; one press should say what works and, when something doesn't, why). A probe makes one real, read-only
 * call to the service and says what came back. Nothing here sends, buys, posts or changes anything.
 *
 *   ok         the service answered the way a working connection does
 *   failed     it is set up and the call failed; the summary is the reason
 *   off        it isn't set up; the summary is what setting it up takes
 *   unchecked  it is set up but can't be checked without doing something (a push to the phone)
 */
export type CheckState = "ok" | "failed" | "off" | "unchecked";
export interface Probe {
  id: string;
  name: string;
  /** Who uses it and for what, in a few words. */
  what?: string;
  /** Why it isn't set up, when it isn't. Then nothing is called. */
  off?: () => string | undefined | Promise<string | undefined>;
  /** The live check: what the service said when it works; throws with the reason when it doesn't. */
  run: () => Promise<string | { state: CheckState; summary: string }>;
  /** A check that signs in through a browser needs longer than a key that is just asked "who am I". */
  timeoutMs?: number;
}
export interface CheckResult { id: string; name: string; what?: string; state: CheckState; summary: string; ms: number; at: string }
export const CONNECTIONS_KEY = "connections.lastCheck";

const tidy = (s: string) => s.replace(/\s+\n/g, "\n").trim().slice(0, 1200) || "it gave no reason";

async function one(p: Probe, timeoutMs: number, now: () => number): Promise<CheckResult> {
  const t0 = now();
  const done = (state: CheckState, summary: string): CheckResult => ({ id: p.id, name: p.name, what: p.what, state, summary: tidy(summary), ms: now() - t0, at: new Date(now()).toISOString() });
  try {
    const why = await p.off?.();
    if (why) return done("off", why);
  } catch (e) { return done("failed", `HQ couldn't tell whether it is set up (${(e as Error).message})`); }
  const limit = p.timeoutMs ?? timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = p.run();
    work.catch(() => undefined); // a check that fails after its time is up has already been reported as late
    const r = await Promise.race([work, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`no answer in ${Math.round(limit / 1000)} seconds`)), limit); })]);
    return typeof r === "string" ? done("ok", r) : done(r.state, r.summary);
  } catch (e) { return done("failed", (e as Error).message || String(e)); }
  finally { if (timer) clearTimeout(timer); }
}

/** Run the probes side by side (one slow service doesn't hold the rest) and answer in the order they were given. */
export async function runChecks(probes: Probe[], opts: { only?: string[]; timeoutMs?: number; now?: () => number } = {}): Promise<CheckResult[]> {
  const want = opts.only?.length ? new Set(opts.only.map((s) => s.toLowerCase())) : undefined;
  const list = want ? probes.filter((p) => want.has(p.id.toLowerCase()) || want.has(p.name.toLowerCase())) : probes;
  return Promise.all(list.map((p) => one(p, opts.timeoutMs ?? 25_000, opts.now ?? Date.now)));
}

/** Keep what was last seen for each connection, so Settings shows it without checking again. */
export function saveChecks(store: Pick<Store, "settings">, results: CheckResult[], known?: string[]): Promise<CheckResult[]> {
  // One save at a time per store: Settings asks for each connection on its own, side by side, while the watch and
  // an agent's connections_check may be saving too, and a read-then-write would drop the others' results.
  const run = (saving.get(store) ?? Promise.resolve()).catch(() => undefined).then(() => saveChecksNow(store, results, known));
  saving.set(store, run);
  return run;
}
const saving = new WeakMap<object, Promise<unknown>>();
async function saveChecksNow(store: Pick<Store, "settings">, results: CheckResult[], known?: string[]): Promise<CheckResult[]> {
  const was = await store.settings.get<CheckResult[]>(CONNECTIONS_KEY, []);
  const fresh = new Map(results.map((r) => [r.id, r]));
  // Order: the order the probes come in when known; a connection that no longer exists is dropped.
  const ids = known ?? [...new Set([...was.map((r) => r.id), ...results.map((r) => r.id)])];
  const next = ids.map((id) => fresh.get(id) ?? was.find((r) => r.id === id)).filter((r): r is CheckResult => !!r);
  await store.settings.set(CONNECTIONS_KEY, next);
  return next;
}
export const lastChecks = (store: Pick<Store, "settings">) => store.settings.get<CheckResult[]>(CONNECTIONS_KEY, []);

/** The results in words: what isn't working first, with the reason; then what works; then what isn't set up. */
export function checksText(results: CheckResult[]): string {
  if (!results.length) return "No connection by that name. Call it with nothing to check them all.";
  const by = (s: CheckState) => results.filter((r) => r.state === s);
  const first = (s: string) => s.split("\n")[0]!.slice(0, 300);
  const bad = by("failed"), ok = by("ok"), off = by("off"), un = by("unchecked");
  const lines = [`Connections checked just now: ${ok.length} working, ${bad.length} not working${off.length ? `, ${off.length} not set up` : ""}${un.length ? `, ${un.length} set but not checkable` : ""}.`];
  if (bad.length) lines.push("NOT WORKING:", ...bad.map((r) => `- ${r.name}: ${r.summary.slice(0, 500)}`));
  if (ok.length) lines.push("WORKING:", ...ok.map((r) => `- ${r.name}: ${first(r.summary)}`));
  if (un.length) lines.push("SET, NOT CHECKED:", ...un.map((r) => `- ${r.name}: ${first(r.summary)}`));
  if (off.length) lines.push("NOT SET UP:", ...off.map((r) => `- ${r.name}: ${first(r.summary)}`));
  return lines.join("\n");
}

/** Telegram: the bot's token is real and the bot can see the chat it messages. Nothing is sent. */
export async function telegramCheck(token: string, chat: string, f: typeof fetch = fetch): Promise<string> {
  const ask = async <T>(method: string, body?: unknown): Promise<T> => {
    let res: Response;
    try { res = await f(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(10_000) }); }
    catch (e) { throw new Error(`Telegram didn't answer (${(e as Error).message.replace(token, "…").slice(0, 80)})`); }
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: T };
    if (!j.ok) throw new Error(res.status === 401 || res.status === 404 ? "Telegram refused the bot token; check TELEGRAM_BOT_TOKEN (BotFather shows the current one)" : `Telegram said: ${j.description ?? res.status}`);
    return j.result as T;
  };
  const me = await ask<{ username?: string }>("getMe");
  let who: { first_name?: string; title?: string; username?: string };
  try { who = await ask("getChat", { chat_id: chat }); }
  catch (e) { throw new Error(`The bot @${me.username} works, but it can't see chat ${chat} (${(e as Error).message}). Open the bot in Telegram, press Start, and check TELEGRAM_CHAT_ID`); }
  return `Bot @${me.username} is answering and can message ${who.title ?? who.first_name ?? who.username ?? `chat ${chat}`}.`;
}

/** xAI: the key is accepted. Listing models costs nothing; no search and no model call is made. */
export async function xaiCheck(key: string, f: typeof fetch = fetch, chatUrl = process.env.XAI_BASE_URL || "https://api.x.ai/v1/chat/completions"): Promise<string> {
  let res: Response;
  try { res = await f(chatUrl.replace(/\/chat\/completions\/?$/, "/models"), { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }); }
  catch (e) { throw new Error(`xAI didn't answer (${(e as Error).message.slice(0, 80)})`); }
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error(`xAI refused the key (${res.status}); check XAI_API_KEY at console.x.ai`);
  if (!res.ok) throw new Error(`xAI answered ${res.status}`);
  const j = (await res.json().catch(() => ({}))) as { data?: unknown[] };
  return `xAI accepted the key${j.data?.length ? ` (${j.data.length} models on it)` : ""}. This check costs nothing; searches are billed as they run.`;
}

/**
 * The tool an agent uses to run the same check Phil has in Settings. The probes come from the server (it holds the
 * connectors), handed in as a function so this stays empty in a test or a web with nothing wired.
 */
export function connectionTools(probes: () => Probe[] | undefined | Promise<Probe[] | undefined>): ToolDef[] {
  return [
    defineTool({
      name: "connections_check",
      description: "Check HQ's connections right now (Google, Robinhood, GoHighLevel, LeadPerfection, Hyperliquid, Kalshi, Telegram and the rest): one real read-only call to each, then what works, what doesn't and why, and what isn't set up. Nothing is sent or changed. With `only`, just those (ids or names, like robinhood or kalshi).",
      schema: { only: z.array(z.string().max(40)).max(30).optional().describe("ids or names of the connections to check; leave out for all") },
      async handler({ only }, ctx) {
        const list = await probes();
        if (!list?.length) return "The connection check isn't available here (nothing is wired to check).";
        const results = await runChecks(list, { only });
        if (results.length) await saveChecks(ctx.store, results, list.map((p) => p.id)).catch(() => undefined);
        return checksText(results);
      },
    }),
  ];
}

// ---- The watch: the same checks on a timer, and a word to Phil only when something that worked stops ---------------

/** Per connection: failed checks in a row, whether it has ever worked, and the Needs-you item raised for it. */
interface Watch { fails: number; seenOk: boolean; itemId?: string; since?: string }
export const CONNECTIONS_WATCH_KEY = "connections.watch";
/** Failed checks in a row before Phil hears of it: one blip (a rate limit, a slow sign-in) isn't news. */
export const WATCH_AFTER = 2;

export interface WatchDeps {
  probes: Probe[];
  store: Pick<Store, "settings">;
  /** Raise a Needs-you item (it reaches his phone); returns its id. */
  raise(title: string, why: string): Promise<string>;
  /** Close the item. `back` is true only when the connection works again (then Phil is told); false when it simply isn't set up any more. */
  resolve(itemId: string, title: string, summary: string, back: boolean): Promise<void>;
  now?: () => number;
}

/**
 * Check every connection and compare with the last time. Phil hears about a connection only when one that has worked
 * fails twice in a row (Needs you, so his phone), and again when it is back (the item closes). What has never worked,
 * or isn't set up, never alerts: Settings shows those, and he decides when they matter.
 */
export async function watchConnections(d: WatchDeps): Promise<{ checked: number; down: string[]; back: string[]; summary: string }> {
  const results = await runChecks(d.probes, { now: d.now });
  await saveChecks(d.store, results, d.probes.map((p) => p.id));
  const was = await d.store.settings.get<Record<string, Watch>>(CONNECTIONS_WATCH_KEY, {});
  const next: Record<string, Watch> = {};
  const down: string[] = [], back: string[] = [];
  for (const r of results) {
    const w: Watch = { ...(was[r.id] ?? { fails: 0, seenOk: false }) };
    if (r.state === "ok") {
      if (w.itemId) { await d.resolve(w.itemId, r.name, r.summary, true).catch(() => undefined); back.push(r.name); }
      next[r.id] = { fails: 0, seenOk: true };
    } else if (r.state === "failed") {
      w.fails++;
      w.since ??= r.at;
      if (w.seenOk && w.fails >= WATCH_AFTER && !w.itemId) {
        w.itemId = await d.raise(`${r.name} stopped working`, `${r.summary.slice(0, 600)}\n\nIt worked before; HQ has seen it fail ${w.fails} checks in a row, three hours apart. Settings › Connections check has a Check button to try it again after you fix it.`).catch(() => undefined);
        if (w.itemId) down.push(r.name);
      }
      next[r.id] = w;
    } else {
      // Not set up any more (Phil disconnected it), or not checkable: no alarm, and an open item about it is closed
      // quietly. It is not "working again", and he isn't told it is.
      if (w.itemId) await d.resolve(w.itemId, r.name, r.summary, false).catch(() => undefined);
      next[r.id] = { fails: 0, seenOk: w.seenOk };
    }
  }
  await d.store.settings.set(CONNECTIONS_WATCH_KEY, next);
  const failing = results.filter((r) => r.state === "failed").map((r) => r.name);
  const summary = `${results.filter((r) => r.state === "ok").length} working${failing.length ? `, not working: ${failing.join(", ")}` : ""}${down.length ? `; told Phil: ${down.join(", ")} stopped` : ""}${back.length ? `; back: ${back.join(", ")}` : ""}`;
  return { checked: results.length, down, back, summary };
}
