import { z } from "zod";
import { bus, type Approval } from "../events.js";
import type { Store } from "../store/types.js";
import { defineTool, type ToolDef } from "../tools/index.js";
import type { Executor, Jarvis } from "../jarvis/orchestrator.js";

/**
 * Mayne's hard limits: position size, daily loss and auto-stop apply even after Phil approves a trade.
 * Nothing here moves money by itself: the trade executor is "paper" until an exchange/wallet connector
 * wraps it with guard.wrap(). The guard also flips the trading kill switch when a limit is breached.
 */
export interface TradingLimits {
  enabled: boolean;
  maxPositionUsd: number;
  maxDailyLossUsd: number;
  maxOpenPositions: number;
  /** Auto-stop: pause all trading when equity falls this far (%) from its recent peak. */
  autoStopDrawdownPct: number;
}

export const DEFAULT_LIMITS: TradingLimits = { enabled: true, maxPositionUsd: 250, maxDailyLossUsd: 500, maxOpenPositions: 3, autoStopDrawdownPct: 10 };

export interface Position { id: string; symbol: string; sizeUsd: number; side: "long" | "short"; openedAt: string; strategy?: string; approvalId?: string }
export interface Ledger {
  day: string;
  realizedPnlUsd: number;
  open: Position[];
  equityUsd?: number;
  peakEquityUsd?: number;
  stoppedAt?: string;
  stopReason?: string;
}

export interface TradeRequest { symbol: string; sizeUsd: number; side: "long" | "short"; strategy?: string }

const LIMITS_KEY = "mayne.limits", LEDGER_KEY = "mayne.ledger";
const today = (now: () => number) => new Date(now()).toISOString().slice(0, 10);

export const limitsSchema = z.object({
  enabled: z.boolean(),
  maxPositionUsd: z.number().min(0).max(10_000_000),
  maxDailyLossUsd: z.number().min(0).max(10_000_000),
  maxOpenPositions: z.number().int().min(0).max(100),
  autoStopDrawdownPct: z.number().min(0).max(100),
}).partial();

export class TradingGuard {
  constructor(private store: Store, private now: () => number = () => Date.now()) {}

  async limits(): Promise<TradingLimits> { return { ...DEFAULT_LIMITS, ...(await this.store.settings.get<Partial<TradingLimits>>(LIMITS_KEY, {})) }; }
  async setLimits(patch: Partial<TradingLimits>): Promise<TradingLimits> {
    const next = { ...(await this.limits()), ...patch };
    await this.store.settings.set(LIMITS_KEY, next);
    return next;
  }

  async ledger(): Promise<Ledger> {
    const l = await this.store.settings.get<Ledger | null>(LEDGER_KEY, null);
    const day = today(this.now);
    if (!l) return { day, realizedPnlUsd: 0, open: [] };
    if (l.day !== day) { const fresh: Ledger = { ...l, day, realizedPnlUsd: 0, stoppedAt: undefined, stopReason: undefined }; await this.store.settings.set(LEDGER_KEY, fresh); return fresh; }
    return l;
  }
  private async save(l: Ledger) { await this.store.settings.set(LEDGER_KEY, l); }

  /** Would this trade break a limit? Checked when Mayne asks and again when the approval executes. */
  async check(t: TradeRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
    const lim = await this.limits();
    if (!lim.enabled) return { ok: true };
    const led = await this.ledger();
    const kill = await this.store.settings.get("killSwitch", { all: false, trading: false, agents: [] as string[] });
    if (kill.all || kill.trading) return { ok: false, reason: "trading is paused (kill switch)" };
    if (led.stoppedAt) return { ok: false, reason: `auto-stop is on since ${led.stoppedAt}: ${led.stopReason}` };
    if (!(t.sizeUsd > 0)) return { ok: false, reason: "size must be positive" };
    if (t.sizeUsd > lim.maxPositionUsd) return { ok: false, reason: `$${t.sizeUsd} is over the max position of $${lim.maxPositionUsd}` };
    if (led.open.length >= lim.maxOpenPositions) return { ok: false, reason: `${led.open.length} positions already open (max ${lim.maxOpenPositions})` };
    if (-led.realizedPnlUsd >= lim.maxDailyLossUsd) return { ok: false, reason: `today's loss $${(-led.realizedPnlUsd).toFixed(0)} has hit the daily limit of $${lim.maxDailyLossUsd}` };
    return { ok: true };
  }

  /** Record an open (paper or real). */
  async open(t: TradeRequest, approvalId?: string): Promise<Position> {
    const led = await this.ledger();
    const p: Position = { id: `${t.symbol}-${this.now().toString(36)}`, symbol: t.symbol, sizeUsd: t.sizeUsd, side: t.side, openedAt: new Date(this.now()).toISOString(), strategy: t.strategy, approvalId };
    led.open.push(p);
    await this.save(led);
    return p;
  }

  /** Record a close with realized P&L; trips the daily-loss and drawdown stops. */
  async close(positionId: string, pnlUsd: number): Promise<{ stopped?: string }> {
    const led = await this.ledger();
    led.open = led.open.filter((p) => p.id !== positionId);
    led.realizedPnlUsd += pnlUsd;
    if (led.equityUsd !== undefined) { led.equityUsd += pnlUsd; led.peakEquityUsd = Math.max(led.peakEquityUsd ?? led.equityUsd, led.equityUsd); }
    await this.save(led);
    return this.enforceStops();
  }

  /** Phil or a wallet connector reports current equity; drives the drawdown auto-stop. */
  async markEquity(equityUsd: number): Promise<{ stopped?: string }> {
    const led = await this.ledger();
    led.equityUsd = equityUsd;
    led.peakEquityUsd = Math.max(led.peakEquityUsd ?? equityUsd, equityUsd);
    await this.save(led);
    return this.enforceStops();
  }

  private async enforceStops(): Promise<{ stopped?: string }> {
    const lim = await this.limits();
    if (!lim.enabled) return {};
    const led = await this.ledger();
    let reason: string | undefined;
    if (-led.realizedPnlUsd >= lim.maxDailyLossUsd && lim.maxDailyLossUsd > 0) reason = `daily loss $${(-led.realizedPnlUsd).toFixed(0)} hit the $${lim.maxDailyLossUsd} limit`;
    if (led.equityUsd !== undefined && led.peakEquityUsd && lim.autoStopDrawdownPct > 0) {
      const dd = ((led.peakEquityUsd - led.equityUsd) / led.peakEquityUsd) * 100;
      if (dd >= lim.autoStopDrawdownPct) reason = `drawdown ${dd.toFixed(1)}% from peak $${led.peakEquityUsd.toFixed(0)} hit the ${lim.autoStopDrawdownPct}% auto-stop`;
    }
    if (!reason || led.stoppedAt) return reason ? { stopped: led.stopReason } : {};
    led.stoppedAt = new Date(this.now()).toISOString();
    led.stopReason = reason;
    await this.save(led);
    const kill = await this.store.settings.get("killSwitch", { all: false, trading: false, agents: [] as string[] });
    await this.store.settings.set("killSwitch", { ...kill, trading: true });
    bus.emitEvent({ type: "agent.status", agentId: "mayne", status: "paused", at: led.stoppedAt, detail: `auto-stop: ${reason}` });
    return { stopped: reason };
  }

  /** Phil clears the auto-stop (the trading kill switch is resumed separately). */
  async clearStop() { const led = await this.ledger(); led.stoppedAt = undefined; led.stopReason = undefined; await this.save(led); }

  tools(): ToolDef[] {
    return [
      defineTool({
        name: "trading_limits",
        description: "Mayne's hard limits and today's ledger: max position, daily loss, open positions, auto-stop state. Check before proposing a trade.",
        schema: {},
        handler: async () => { const lim = await this.limits(), led = await this.ledger(); return `Limits ${lim.enabled ? "ON" : "OFF"}: max position $${lim.maxPositionUsd}, max daily loss $${lim.maxDailyLossUsd}, max open ${lim.maxOpenPositions}, auto-stop at ${lim.autoStopDrawdownPct}% drawdown.\nToday (${led.day}): realized P&L $${led.realizedPnlUsd.toFixed(2)}, open positions ${led.open.length}${led.open.length ? ": " + led.open.map((p) => `${p.side} ${p.symbol} $${p.sizeUsd}`).join(", ") : ""}${led.equityUsd !== undefined ? `, equity $${led.equityUsd.toFixed(0)} (peak $${(led.peakEquityUsd ?? led.equityUsd).toFixed(0)})` : ""}${led.stoppedAt ? `\nAUTO-STOP ON: ${led.stopReason}` : ""}`; },
      }),
    ];
  }

  /** Wrap a real trade executor so the limits apply at execution time, even after approval. */
  wrap(exec: (t: TradeRequest, a: Approval, jarvis: Jarvis) => Promise<string | void>): Executor {
    return async (a, jarvis) => {
      const t = parseTrade(a.payload);
      const c = await this.check(t);
      if (!c.ok) throw new Error(`blocked by Mayne's hard limits: ${c.reason}`);
      const out = await exec(t, a, jarvis);
      const p = await this.open(t, a.id);
      return out || `Opened ${t.side} ${t.symbol} for $${t.sizeUsd} (paper, ${p.id}).`;
    };
  }

  executors(): Record<string, Executor> {
    return {
      // Paper execution until a wallet/exchange connector replaces it with guard.wrap(real).
      "trade.execute": this.wrap(async () => undefined),
      "trade.close": async (a) => { const p = a.payload as { positionId?: string; pnlUsd?: number }; if (!p.positionId) throw new Error("positionId is required"); const r = await this.close(p.positionId, Number(p.pnlUsd ?? 0)); return `Closed ${p.positionId} with $${Number(p.pnlUsd ?? 0).toFixed(2)}${r.stopped ? ` — AUTO-STOP: ${r.stopped}` : ""}.`; },
      "strategy.enable": async (a) => { const p = a.payload as { name?: string }; const list = await this.store.settings.get<{ name: string; enabledAt: string; approvalId: string }[]>("strategies", []); await this.store.settings.set("strategies", [...list.filter((s) => s.name !== p.name), { name: String(p.name ?? a.title), enabledAt: new Date(this.now()).toISOString(), approvalId: a.id }]); return `Strategy "${p.name ?? a.title}" enabled for Mayne, inside the hard limits.`; },
    };
  }

  static promptHint(): string {
    return `Trading goes through Mayne's hard limits (call trading_limits first). A trade = an approval block with "kind":"money" and "payload":{"action":"trade.execute","symbol":"...","side":"long|short","sizeUsd":<number>,"strategy":"<name>"}. Closing = {"action":"trade.close","positionId":"...","pnlUsd":<number>}. A new Analyzer strategy = "kind":"strategy" with "payload":{"action":"strategy.enable","name":"...","backtestReturn":"...","winRate":"...","maxDrawdown":"...","paperDays":<n>}. Over-limit trades are refused even after approval.`;
  }
}

export function parseTrade(payload: unknown): TradeRequest {
  const p = (payload ?? {}) as Record<string, unknown>;
  const symbol = String(p.symbol ?? "").trim();
  const sizeUsd = Number(p.sizeUsd ?? p.amount ?? NaN);
  const side = p.side === "short" ? "short" : "long";
  if (!symbol || !Number.isFinite(sizeUsd)) throw new Error("trade needs symbol and sizeUsd");
  return { symbol, sizeUsd, side, strategy: p.strategy ? String(p.strategy) : undefined };
}
