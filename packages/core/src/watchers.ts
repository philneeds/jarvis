import type { Jarvis } from "./jarvis/orchestrator.js";
import { getAgent } from "./registry/index.js";
import { deliverReports, type RoutineReport } from "./scheduler.js";
import type { GoHighLevelConnector } from "./connectors/gohighlevel.js";
import { hyperliquidPerps, perpsText, type PerpRow } from "./hyperliquid.js";

/**
 * Watchers: how a lead is "always on" without a model running all day. Each watcher looks at one source on a short
 * timer with no model involved (an API call, a few cents at most), keeps a cursor, and wakes its agent only when
 * something new happened: a customer wrote in, funding went extreme. The agent then acts as the owner of that area
 * and the result goes up the chain like a routine's. Nothing wakes during quiet hours, each watcher has a daily cap,
 * and the run goes through the usage caps like any background run.
 *   WATCH_QUIET            quiet hours, server-local, default "22:00-06:30" (the morning routines cover the gap)
 *   WATCH_FUNDING_HR       Hyperliquid funding that counts as extreme, in % per hour (default 0.01, about 88% APR)
 *   WATCH_MOVE_PCT         a 24h move that counts as big (default 10)
 *   WATCH_OI_MIN_USD       only markets with at least this much open interest (default 20,000,000)
 */
export interface WatchDeps { ghl?: GoHighLevelConnector; fetch?: typeof fetch }
export interface WatchResult { event?: string; cursor: unknown }
export interface Watcher {
  id: string;
  agentId: string;
  /** Minutes between looks. */
  every: number;
  /** Phase in which this watcher is on. */
  phase: number;
  /** Most wakes per day; past it, events are parked in the agent's memory for its next run. */
  maxPerDay: number;
  summary: string;
  /** One look at the source, no model: the event text for the agent when something is new, and the cursor to keep. */
  check(cursor: unknown, deps: WatchDeps): Promise<WatchResult>;
}
export interface WatchState { cursor?: unknown; lastCheck?: number; day?: string; fired?: number; lastError?: string; heldToday?: boolean }
export const WATCH_STATE_KEY = "watch.state";

type Conv = Parameters<GoHighLevelConnector["conversationsText"]>[0][number];
const epoch = (v?: number | string): number => { if (v === undefined || v === null || v === "") return 0; const n = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v); return Number.isFinite(n) ? n : 0; };
const et = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** New inbound customer messages in GoHighLevel since the cursor (the newest inbound message time seen). */
export function ghlInbound(convs: Conv[], cursor: unknown, now: number): WatchResult & { fresh: Conv[] } {
  const inbound = convs.filter((c) => c.lastMessageDirection === "inbound" && epoch(c.lastMessageDate) > 0);
  const newest = inbound.reduce((m, c) => Math.max(m, epoch(c.lastMessageDate)), 0);
  // First look: start from now, so an old backlog doesn't wake anyone; the morning routine already covers it.
  if (typeof cursor !== "number") return { cursor: Math.max(newest, now), fresh: [] };
  const fresh = inbound.filter((c) => epoch(c.lastMessageDate) > cursor).sort((a, b) => epoch(b.lastMessageDate) - epoch(a.lastMessageDate));
  return { cursor: Math.max(cursor, newest), fresh };
}

/** Markets that just became extreme: funding past the threshold or a big 24h move, on markets with real open interest. */
export function fundingExtremes(rows: PerpRow[], cursor: unknown, th = thresholds()): WatchResult & { coins: string[] } {
  const flagged = rows.filter((r) => r.oiUsd >= th.oiMinUsd && (Math.abs(r.fundingHr) >= th.fundingHr || Math.abs(r.change24h) >= th.movePct)).map((r) => r.coin).sort();
  const before = Array.isArray(cursor) ? (cursor as string[]) : undefined;
  if (!before) return { cursor: flagged, coins: [] };
  const coins = flagged.filter((c) => !before.includes(c));
  return { cursor: flagged, coins };
}
export function thresholds() {
  const n = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return { fundingHr: n("WATCH_FUNDING_HR", 0.01), movePct: n("WATCH_MOVE_PCT", 10), oiMinUsd: n("WATCH_OI_MIN_USD", 20_000_000) };
}

export const WATCHERS: Watcher[] = [
  {
    id: "ghl-inbound", agentId: "stella", every: 10, phase: 1, maxPerDay: 12,
    summary: "A customer or lead writes to JD PM in GoHighLevel: Stella wakes, reads the thread and routes it (Stephanie replies, Karol logs a lead).",
    async check(cursor, deps) {
      if (!deps.ghl) return { cursor };
      const r = ghlInbound(await deps.ghl.conversations(true, 20), cursor, Date.now());
      if (!r.fresh.length) return { cursor: r.cursor };
      const since = typeof cursor === "number" ? ` since ${et(cursor)} ET` : "";
      return { cursor: r.cursor, event: `${r.fresh.length} new customer message${r.fresh.length === 1 ? "" : "s"} in GoHighLevel${since}:\n${deps.ghl.conversationsText(r.fresh, true)}\n\nRead each thread (ghl_messages) before deciding. A reply to a customer is Stephanie's (hand it off; she drafts it as an approval for Phil), a new lead is Karol's, a quote question is Jake's.` };
    },
  },
  {
    id: "hl-funding", agentId: "pentoshi", every: 30, phase: 2, maxPerDay: 6,
    summary: "Hyperliquid funding goes extreme or a big market moves 10% in a day: Pentoshi wakes with the numbers and reports to Mantis.",
    async check(cursor, deps) {
      const rows = await hyperliquidPerps(deps.fetch ?? fetch);
      const r = fundingExtremes(rows, cursor);
      if (!r.coins.length) return { cursor: r.cursor };
      const th = thresholds();
      return { cursor: r.cursor, event: `Hyperliquid just went extreme on ${r.coins.join(", ")} (funding past ${th.fundingHr}%/h or a 24h move past ${th.movePct}%, open interest over $${Math.round(th.oiMinUsd / 1e6)}M):\n${perpsText(rows, r.coins)}\n\nSay what it means for positioning, with the numbers; this goes to Mantis, not Phil.` };
    },
  },
];

/** Is `now` inside the quiet window "HH:MM-HH:MM" (server-local, may cross midnight)? */
export function inQuietHours(now: Date, spec = process.env.WATCH_QUIET ?? "22:00-06:30"): boolean {
  const m = spec.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]), end = Number(m[3]) * 60 + Number(m[4]), t = now.getHours() * 60 + now.getMinutes();
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

export interface WatcherView { id: string; agentId: string; every: number; summary: string; active: boolean; lastCheck?: string; firedToday: number; maxPerDay: number; lastError?: string }

export class Watchers {
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();
  constructor(private jarvis: Jarvis, private deps: WatchDeps = {}, private watchers: Watcher[] = WATCHERS) {}

  start(tickMs = 60_000) {
    this.stop();
    this.timer = setInterval(() => void this.tick().catch((e) => console.warn("[watch] tick:", (e as Error).message)), tickMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Which watchers get a look at `now`. Exposed for tests. */
  due(now: Date, phase: number, state: Record<string, WatchState>, watchers: Watcher[] = this.watchers): Watcher[] {
    if (inQuietHours(now)) return [];
    return watchers.filter((w) => {
      const agent = getAgent(w.agentId);
      if (!agent || w.phase > phase || agent.phase > phase) return false;
      const last = state[w.id]?.lastCheck ?? 0;
      return now.getTime() - last >= w.every * 60_000;
    });
  }

  async tick(now = new Date()) {
    const phase = await this.jarvis.store.settings.get("phase", 0);
    const state = await this.jarvis.store.settings.get<Record<string, WatchState>>(WATCH_STATE_KEY, {});
    for (const w of this.due(now, phase, state)) {
      if (this.running.has(w.id)) continue;
      this.running.add(w.id);
      const st: WatchState = { ...(state[w.id] ?? {}) };
      const today = now.toISOString().slice(0, 10);
      if (st.day !== today) { st.day = today; st.fired = 0; st.heldToday = false; }
      try {
        const r = await w.check(st.cursor, this.deps);
        st.cursor = r.cursor; st.lastCheck = now.getTime();
        if (st.lastError) { await this.jarvis.router.log(w.agentId, "system", `Watcher ${w.id} is reading its source again.`); st.lastError = undefined; }
        if (r.event) {
          if ((st.fired ?? 0) >= w.maxPerDay) {
            await this.park(w, r.event, `${w.maxPerDay} wakes today already`);
            if (!st.heldToday) { await this.jarvis.router.log(w.agentId, "system", `Watcher ${w.id}: ${getAgent(w.agentId)?.name ?? w.agentId} has woken ${w.maxPerDay} times today; the rest waits for the next run.`); st.heldToday = true; }
          } else {
            st.fired = (st.fired ?? 0) + 1;
            await this.fire(w, r.event);
          }
        }
      } catch (e) {
        const msg = (e as Error).message.slice(0, 200);
        st.lastCheck = now.getTime();
        // A source that's down is said once, not every ten minutes.
        if (st.lastError !== msg) await this.jarvis.router.log(w.agentId, "error", `Watcher ${w.id} couldn't read its source: ${msg}`);
        st.lastError = msg;
      } finally {
        this.running.delete(w.id);
        const fresh = await this.jarvis.store.settings.get<Record<string, WatchState>>(WATCH_STATE_KEY, {});
        await this.jarvis.store.settings.set(WATCH_STATE_KEY, { ...fresh, [w.id]: st });
      }
    }
  }

  /** Wake the agent with the event; its answer goes up the chain. Held by a cap or a pause, the event is parked instead. */
  private async fire(w: Watcher, event: string) {
    const agent = getAgent(w.agentId)!;
    const headline = event.split("\n")[0]!.slice(0, 140);
    const r = await this.jarvis.runAgent(agent, `${event}\n\nThis came from HQ's ${w.id} watcher the moment it happened, not from Phil: act on it as the owner of this area. Hand anything that belongs to a teammate to them, keep what matters in memory and on the board, and raise an approval or attention block only if Phil himself must act. Reply in a few lines on what you did.`, { direct: false, from: "Watcher" });
    if (r.blocked) { await this.park(w, event, r.blocked); return; }
    await this.jarvis.router.log(agent.id, "schedule", `Watcher ${w.id}: ${agent.name} woke on ${headline}`, r.runId);
    const report: RoutineReport = { agent, scheduleId: `watch:${w.id}`, text: r.text, runId: r.runId };
    await deliverReports(this.jarvis, agent.parent ?? "jarvis", [report]);
  }

  /** The event waits in the agent's own memory, so its next run (routine or on demand) starts from it. */
  private async park(w: Watcher, event: string, why: string) {
    const agent = getAgent(w.agentId)!;
    const when = new Date().toISOString().slice(0, 16).replace("T", " ");
    await this.jarvis.store.memory.set({ scope: `agent:${agent.id}`, key: `watch:${w.id}`, value: `${w.id} watcher saw this on ${when} UTC and you haven't acted on it yet (${why}): ${event.replace(/\s+/g, " ").slice(0, 1500)}`, source: "watcher" });
    await this.jarvis.router.log(agent.id, "system", `Watcher ${w.id}: ${agent.name} couldn't take it now (${why}); parked in ${agent.name}'s memory for the next run.`);
  }

  /** For the Schedules screen and web_status. */
  async view(now = new Date()): Promise<WatcherView[]> {
    const phase = await this.jarvis.store.settings.get("phase", 0);
    const state = await this.jarvis.store.settings.get<Record<string, WatchState>>(WATCH_STATE_KEY, {});
    const today = now.toISOString().slice(0, 10);
    return this.watchers.map((w) => {
      const st = state[w.id];
      const agent = getAgent(w.agentId);
      return { id: w.id, agentId: w.agentId, every: w.every, summary: w.summary, active: !!agent && w.phase <= phase && agent.phase <= phase, lastCheck: st?.lastCheck ? new Date(st.lastCheck).toISOString() : undefined, firedToday: st?.day === today ? st.fired ?? 0 : 0, maxPerDay: w.maxPerDay, lastError: st?.lastError };
    });
  }
}
