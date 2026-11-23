import { constants, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import type { Store } from "./store/types.js";
import type { Approval } from "./events.js";
import type { Describer, Executor } from "./jarvis/orchestrator.js";
import { defineTool, type ToolDef } from "./tools/index.js";
import { NOT_PLACED } from "./hyperliquid-trade.js";

/**
 * Trading on Kalshi (prediction markets; US-regulated), for Cat. The same two ways as Hyperliquid, Phil's choice in
 * Settings › Kalshi: every order waits for his card (the default), or Cat trades on her own inside the parameters he
 * set and only a change to them waits for him (Phil, Nov 23 2026: "start building #3").
 *
 * Built against Kalshi's Trade API as documented in November 2026 (docs.kalshi.com), which is not the older API:
 *   - orders go to POST /portfolio/events/orders (the old /portfolio/orders writes answer 410), quoted from the YES
 *     side of one book: "bid" buys YES at a price, "ask" sells YES, and selling YES at p is buying NO at 1 − p
 *   - prices are dollar strings ("0.5600") on the market's own grid (price_ranges), counts are strings ("10.00")
 *   - every request is signed: timestamp + METHOD + path, RSA-PSS/SHA-256 (or Ed25519), three KALSHI-ACCESS headers
 *   KALSHI_API_KEY_ID         the key's id (Kalshi › Account & security › API Keys)
 *   KALSHI_PRIVATE_KEY_FILE   the path of the .pem Kalshi gave when the key was made (or KALSHI_PRIVATE_KEY, the PEM
 *                             itself with \n for line breaks)
 *   KALSHI_API_BASE           optional, e.g. the demo host; production by default
 * A key with the scopes "read" and "write::trade" can read the account and place and cancel orders, and nothing
 * else: it can't move money between accounts or make keys. Kalshi's API has no withdrawal at all.
 * What HQ wires in: an order to buy YES or NO, closing a position (reduce-only), cancelling a resting order, and the
 * parameters. The most a contract can lose is what it cost, so the caps are in dollars of cost: per order, per day,
 * and in all positions and resting orders together.
 */
const BASE = "https://external-api.kalshi.com/trade-api/v2";
const LIMITS_KEY = "kalshi.limits";
const SPENT_KEY = "kalshi.spent";
/** Resting orders HQ placed, so a cancel on her own never touches one Phil placed by hand. */
const OURS_KEY = "kalshi.ourOrders";

export interface KalshiLimits {
  /** Cat trades on her own inside the caps below. */
  auto?: boolean;
  /** Dollars one order may cost, and all new orders in a day (ET). Over either, an order is refused. */
  maxOrderUsd?: number; maxDayUsd?: number;
  /** Most dollars at risk in all: what open positions cost plus what resting orders would. */
  maxOpenUsd?: number;
}
/** The agent who may trade on her own. */
export const KALSHI_TRADER = "cat";
export function kalshiAutoMissing(l: KalshiLimits): string[] {
  return [!l.maxOrderUsd && "a per-order cap", !l.maxDayUsd && "a daily cap", !l.maxOpenUsd && "a cap on everything open"].filter((x): x is string => !!x);
}
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const cents = (p: number) => `${+(p * 100).toFixed(2)}¢`;
export function kalshiLimitsText(l: KalshiLimits): string {
  const caps = `${l.maxOrderUsd ? `${usd(l.maxOrderUsd)} an order` : "no per-order cap"}, ${l.maxDayUsd ? `${usd(l.maxDayUsd)} a day` : "no daily cap"}${l.maxOpenUsd ? `, ${usd(l.maxOpenUsd)} open in all` : ""}`;
  return l.auto ? `Cat trades on her own: up to ${caps}.` : `Every order waits for Phil's card. Caps: ${caps}.`;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const day = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const closePct = (v: unknown) => { const n = Math.round(num(v)); return n >= 1 && n <= 100 ? n : 100; };

/** What a card asks for: buy YES or NO contracts of a market, at a limit price (of that side) or at market. */
export interface KalshiAsk { ticker: string; side: "yes" | "no"; count: number; price?: number; market: boolean; slippage: number }
export function readKalshiOrder(p: Record<string, unknown>): KalshiAsk {
  const ticker = String(p.ticker ?? "").trim().toUpperCase();
  if (!ticker) throw new Error('the card needs the market\'s "ticker"');
  const side = String(p.side ?? "").toLowerCase();
  if (side !== "yes" && side !== "no") throw new Error('the card needs "side": yes or no (the outcome to buy)');
  const count = num(p.count);
  if (!Number.isInteger(count) || count < 1) throw new Error('the card needs "count": a whole number of contracts');
  // A price is the price of the side being bought, in dollars (0.56) or cents (56).
  let price = p.price === undefined || p.price === null || p.price === "" ? undefined : num(String(p.price).replace(/[$¢\s]/g, ""));
  if (price !== undefined && price >= 1 && price < 100) price = price / 100;
  if (price !== undefined && !(price > 0 && price < 1)) throw new Error("the price is a contract's price: between 1¢ and 99¢");
  const market = String(p.type ?? (price === undefined ? "market" : "limit")).toLowerCase() !== "limit";
  if (!market && price === undefined) throw new Error("a limit order needs its price");
  let slip = num(p.slippage);
  if (slip >= 1) slip = slip / 100;
  return { ticker, side, count, price: market ? undefined : price, market, slippage: Math.min(Math.max(slip || 0.02, 0.01), 0.1) };
}

type Range = { start: string; end: string; step: string };
interface KMarket { ticker: string; title?: string; status?: string; yes_bid_dollars?: string; yes_ask_dollars?: string; no_bid_dollars?: string; no_ask_dollars?: string; price_ranges?: Range[]; close_time?: string }
interface KPosition { ticker: string; position_fp?: string; market_exposure_dollars?: string; realized_pnl_dollars?: string }
interface KOrder { order_id: string; ticker: string; outcome_side?: "yes" | "no"; status?: string; yes_price_dollars?: string; no_price_dollars?: string; remaining_count_fp?: string }

/** A YES price put on the market's grid: the nearest tick, or the next one up or down. */
export function snapPrice(p: number, ranges: Range[] | undefined, dir: "up" | "down" | "near"): number {
  const rs = ranges?.length ? ranges : [{ start: "0.0000", end: "1.0000", step: "0.0100" }];
  const r = rs.find((x) => p >= num(x.start) - 1e-9 && p <= num(x.end) + 1e-9) ?? rs[rs.length - 1]!;
  const start = num(r.start), step = num(r.step) || 0.01;
  const k = (p - start) / step;
  const n = dir === "up" ? Math.ceil(k - 1e-6) : dir === "down" ? Math.floor(k + 1e-6) : Math.round(k);
  return +Math.min(Math.max(start + n * step, 0), 1).toFixed(4);
}

export class KalshiTrader {
  readonly id = "kalshi-trade";
  private queue: Promise<unknown> = Promise.resolve();
  private ok?: { at: number; v: { trading: boolean; problem?: string; balance?: number; portfolio?: number } };
  constructor(private store: Store, private opts: { keyId: string; key: KeyObject; base?: string; fetch?: typeof fetch; now?: () => number }) {}

  /** From the environment: the key id and the .pem. Nothing set, or a file that isn't a key, and trading stays off. */
  static async fromEnv(store: Store): Promise<KalshiTrader | undefined> {
    const keyId = process.env.KALSHI_API_KEY_ID?.trim();
    if (!keyId) return undefined;
    let pem = process.env.KALSHI_PRIVATE_KEY?.replace(/\\n/g, "\n");
    const file = process.env.KALSHI_PRIVATE_KEY_FILE?.trim();
    if (!pem && file) pem = await fs.readFile(file, "utf8").catch(() => undefined);
    if (!pem) { console.warn("[kalshi] KALSHI_API_KEY_ID is set but there's no private key (KALSHI_PRIVATE_KEY_FILE); trading stays off"); return undefined; }
    try { return new KalshiTrader(store, { keyId, key: createPrivateKey(pem), base: process.env.KALSHI_API_BASE?.trim() || undefined }); }
    catch { console.warn("[kalshi] the private key couldn't be read as a PEM key; trading stays off"); return undefined; }
  }

  /** The three headers Kalshi wants: the key id, the time, and timestamp + METHOD + path signed with the key. */
  private headers(method: string, path: string): Record<string, string> {
    const ts = String((this.opts.now ?? Date.now)());
    const msg = Buffer.from(`${ts}${method}${path}`);
    const sig = this.opts.key.asymmetricKeyType === "ed25519"
      ? cryptoSign(null, msg, this.opts.key)
      : cryptoSign("sha256", msg, { key: this.opts.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
    return { "KALSHI-ACCESS-KEY": this.opts.keyId, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sig.toString("base64") };
  }
  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const url = new URL(`${this.opts.base ?? BASE}${path}`);
    // Signed over the path from the API's root, without the query.
    const res = await (this.opts.fetch ?? fetch)(url, { method, headers: { ...this.headers(method, url.pathname), accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string; details?: string }; code?: string; message?: string; details?: string };
    if (res.ok) return j;
    const e = j.error ?? j;
    const said = [e.code, e.message, e.details].filter(Boolean).join(": ");
    const scope = /insufficient_scope:_?([a-z_:]+?)_required/.exec(String(e.code ?? ""));
    if (res.status === 403 && scope) throw new Error(`Kalshi's key lacks the "${scope[1]}" permission; make a key with read and trade access`);
    if (res.status === 401) throw new Error(`Kalshi refused the key (${said || "401"}); check KALSHI_API_KEY_ID and the .pem, and the server's clock`);
    if (res.status === 429) throw new Error("Kalshi's rate limit is hit; try again in a moment");
    throw new Error(`Kalshi answered ${res.status}${said ? `: ${said}` : ""}`);
  }

  async limits(): Promise<KalshiLimits> { return this.store.settings.get<KalshiLimits>(LIMITS_KEY, {}); }
  /** The parameters, as Phil set them in Settings or approved on a card. Trading on her own needs every cap. */
  async setLimits(l: KalshiLimits): Promise<KalshiLimits> {
    const clean = (v: unknown, what: string) => {
      if (v === undefined || v === null || v === "" || v === 0) return undefined;
      const n = Number(String(v).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a number, not "${String(v)}"`);
      const f = Math.floor(n);
      return f > 0 ? f : undefined;
    };
    if (l.auto !== undefined && typeof l.auto !== "boolean") throw new Error(`"auto" must be true or false, not "${String(l.auto)}"`);
    const next: KalshiLimits = { auto: l.auto === true, maxOrderUsd: clean(l.maxOrderUsd, "the per-order cap"), maxDayUsd: clean(l.maxDayUsd, "the daily cap"), maxOpenUsd: clean(l.maxOpenUsd, "the cap on everything open") };
    const missing = kalshiAutoMissing(next);
    if (next.auto && missing.length) throw new Error(`Cat can trade on her own only once every cap is set: add ${missing.join(", ")}`);
    await this.store.settings.set(LIMITS_KEY, next);
    return next;
  }

  /** Whether the key works, and what the account holds. Asked of Kalshi, kept for half a minute. */
  async status(fresh = false): Promise<{ trading: boolean; problem?: string; balance?: number; portfolio?: number; limits: KalshiLimits }> {
    const limits = await this.limits();
    const now = (this.opts.now ?? Date.now)();
    if (!fresh && this.ok && now - this.ok.at < 30_000) return { ...this.ok.v, limits };
    let v: NonNullable<KalshiTrader["ok"]>["v"];
    try {
      const b = await this.call<{ balance?: number; balance_dollars?: string; portfolio_value?: number }>("GET", "/portfolio/balance");
      v = { trading: true, balance: b.balance_dollars !== undefined ? num(b.balance_dollars) : num(b.balance) / 100, portfolio: num(b.portfolio_value) / 100 };
    } catch (e) { v = { trading: false, problem: (e as Error).message }; }
    this.ok = { at: now, v };
    return { ...v, limits };
  }
  private async ready(): Promise<void> {
    const s = await this.status();
    if (!s.trading) throw new Error(s.problem ?? "Kalshi trading isn't set up");
  }

  async market(ticker: string): Promise<KMarket> {
    const j = await this.call<{ market?: KMarket }>("GET", `/markets/${encodeURIComponent(ticker)}`);
    if (!j.market?.ticker) throw new Error(`${ticker} isn't a Kalshi market`);
    return j.market;
  }
  private async positions(ticker?: string): Promise<KPosition[]> {
    const j = await this.call<{ market_positions?: KPosition[] }>("GET", `/portfolio/positions?limit=200${ticker ? `&ticker=${encodeURIComponent(ticker)}` : ""}`);
    return (j.market_positions ?? []).filter((p) => num(p.position_fp) !== 0);
  }
  private async resting(ticker?: string): Promise<KOrder[]> {
    const j = await this.call<{ orders?: KOrder[] }>("GET", `/portfolio/orders?status=resting&limit=200${ticker ? `&ticker=${encodeURIComponent(ticker)}` : ""}`);
    return j.orders ?? [];
  }
  /** Dollars at risk now: what open positions cost, plus what resting orders would cost if they filled. */
  private async openUsd(): Promise<number> {
    const [pos, orders] = await Promise.all([this.positions(), this.resting()]);
    const held = pos.reduce((t, p) => t + Math.abs(num(p.market_exposure_dollars)), 0);
    const waiting = orders.reduce((t, o) => t + num(o.remaining_count_fp) * num(o.outcome_side === "no" ? o.no_price_dollars : o.yes_price_dollars), 0);
    return held + waiting;
  }

  /**
   * The order as it would go out. Kalshi quotes one book from the YES side, so buying NO at q is sent as "ask"
   * (sell YES) at 1 − q. A market order is an immediate-or-cancel limit a little past the best offer.
   */
  async plan(ask: KalshiAsk) {
    const m = await this.market(ask.ticker);
    if (m.status && m.status !== "active") throw new Error(`${m.ticker} isn't trading (it is ${m.status})`);
    const yesAsk = num(m.yes_ask_dollars), yesBid = num(m.yes_bid_dollars);
    let own: number; // the price of the side being bought
    if (ask.market) {
      const offer = ask.side === "yes" ? yesAsk : yesBid > 0 ? 1 - yesBid : 0;
      if (!(offer > 0 && offer < 1)) throw new Error(`nobody is offering ${ask.side.toUpperCase()} on ${m.ticker} right now; give a limit price`);
      own = Math.min(offer + ask.slippage, 0.99);
    } else own = ask.price!;
    // On the grid, from the YES side: a market order moves to the next tick that still fills; a limit must already be on one.
    const yesRaw = ask.side === "yes" ? own : 1 - own;
    const yes = snapPrice(yesRaw, m.price_ranges, ask.market ? (ask.side === "yes" ? "up" : "down") : "near");
    if (!ask.market && Math.abs(yes - yesRaw) > 1e-9) { const near = ask.side === "yes" ? yes : +(1 - yes).toFixed(4); throw new Error(`${m.ticker} prices go in steps: ${cents(own)} isn't one; the nearest is ${cents(near)}`); }
    if (!(yes > 0 && yes < 1)) throw new Error("that price is off the market's range");
    own = ask.side === "yes" ? yes : +(1 - yes).toFixed(4);
    return { m, own, cost: +(ask.count * own).toFixed(4), body: { ticker: m.ticker, side: ask.side === "yes" ? "bid" : "ask", count: ask.count.toFixed(2), price: yes.toFixed(4), time_in_force: ask.market ? "immediate_or_cancel" : "good_till_canceled", self_trade_prevention_type: "taker_at_cross" } };
  }

  /** Refused before Phil sees it: a market that isn't trading, a price off the grid, or over a cap he set. */
  async preflight(a: Omit<Approval, "id" | "at" | "status">): Promise<string | undefined> {
    const p = (a.payload ?? {}) as Record<string, unknown>;
    if (p.action !== "kalshi.order") return undefined;
    try {
      const q = await this.plan(readKalshiOrder(p));
      const l = await this.limits();
      if (l.maxOrderUsd && q.cost > l.maxOrderUsd) return `${usd(q.cost)} is over the ${usd(l.maxOrderUsd)} per-order cap.`;
      const spent = await this.store.settings.get<{ day: string; usd: number }>(SPENT_KEY, { day: day(), usd: 0 });
      const today = spent.day === day() ? spent.usd : 0;
      if (l.maxDayUsd && today + q.cost > l.maxDayUsd) return `that would take today to ${usd(today + q.cost)}, over the ${usd(l.maxDayUsd)} daily cap.`;
      return undefined;
    } catch (e) { return (e as Error).message; }
  }

  /** For HQ's approval flow: run this card now, or leave it for Phil and say why on it (nothing to say for other cards). */
  async runsAlone(a: Pick<Approval, "agentId" | "payload">): Promise<{ ok: boolean; why?: string }> {
    let why: string | undefined;
    try { why = await this.autoRefusal(a); } catch (e) { why = `it couldn't be checked (${(e as Error).message})`; }
    if (!why) return { ok: true, why: "inside your Kalshi trading parameters" };
    return { ok: false, why: /^(not a Kalshi trade|only Cat|trading on her own is off)/.test(why) ? undefined : `${NOT_PLACED}${why}` };
  }
  /** Undefined when a card may run without Phil (Cat's, on, inside every cap); else why not. Closing only takes risk off. */
  async autoRefusal(a: Pick<Approval, "agentId" | "payload">): Promise<string | undefined> {
    const p = (a.payload ?? {}) as Record<string, unknown>;
    const action = String(p.action ?? "");
    if (!/^kalshi\.(order|close|cancel)$/.test(action)) return "not a Kalshi trade";
    if (a.agentId !== KALSHI_TRADER) return "only Cat trades on her own";
    const l = await this.limits();
    if (!l.auto) return "trading on her own is off";
    const missing = kalshiAutoMissing(l);
    if (missing.length) return `trading on her own needs ${missing.join(", ")}`;
    const kill = await this.store.settings.get<{ all?: boolean; trading?: boolean; agents?: string[] }>("killSwitch", {});
    if (kill.all || kill.trading || kill.agents?.includes(KALSHI_TRADER)) return "trading is paused";
    const s = await this.status();
    if (!s.trading) return s.problem ?? "Kalshi trading isn't set up";
    if (action === "kalshi.close") return undefined;
    if (action === "kalshi.cancel") {
      const ours = await this.store.settings.get<string[]>(OURS_KEY, []);
      const ticker = String(p.ticker ?? "").toUpperCase();
      const hit = (await this.resting(ticker || undefined)).filter((o) => !p.orderId || o.order_id === String(p.orderId));
      const theirs = hit.filter((o) => !ours.includes(o.order_id));
      return theirs.length ? `${theirs.length === 1 ? "an order" : `${theirs.length} orders`} there weren't placed by HQ (yours, by hand?), so cancelling ${theirs.length === 1 ? "it" : "them"} is your call` : undefined;
    }
    const q = await this.plan(readKalshiOrder(p));
    const open = await this.openUsd();
    if (open + q.cost > l.maxOpenUsd!) return `it would take everything open to ${usd(open + q.cost)}, over your ${usd(l.maxOpenUsd!)} cap`;
    return undefined;
  }

  private async tally(cost: number) {
    const s = await this.store.settings.get<{ day: string; usd: number }>(SPENT_KEY, { day: day(), usd: 0 });
    await this.store.settings.set(SPENT_KEY, { day: day(), usd: +((s.day === day() ? s.usd : 0) + cost).toFixed(2) });
  }
  /** One order at a time, so two cards approved together can't both slip under a cap before either is counted. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async placeOrderNow(a: Approval): Promise<string> {
    await this.ready();
    const payload = (a.payload ?? {}) as Record<string, unknown>;
    const ask = readKalshiOrder(payload);
    const blocked = await this.preflight(a);
    if (blocked) throw new Error(blocked);
    // Placed on her own: checked once more now, in line behind any order before it.
    if (/^auto:/.test(a.note ?? "")) { const why = await this.autoRefusal(a); if (why) throw new Error(`${NOT_PLACED}${why}`); }
    const q = await this.plan(ask);
    const r = await this.call<{ order_id: string; fill_count?: string; remaining_count?: string; average_fill_price?: string }>("POST", "/portfolio/events/orders", { ...q.body, client_order_id: `hq-${a.id}`.slice(0, 64) });
    this.ok = undefined;
    const filled = num(r.fill_count), left = num(r.remaining_count);
    // The fill price comes back from the YES side: a NO bought at q filled at 1 − q there.
    const paid = filled ? (ask.side === "yes" ? num(r.average_fill_price) : 1 - num(r.average_fill_price)) : 0;
    const resting = ask.market ? 0 : left;
    await this.tally(filled * (paid || q.own) + resting * q.own);
    if (resting > 0) { const ours = await this.store.settings.get<string[]>(OURS_KEY, []); await this.store.settings.set(OURS_KEY, [...ours, r.order_id].slice(-300)); }
    const what = `${ask.side.toUpperCase()} on ${q.m.ticker}`;
    const parts = [
      filled ? `bought ${filled} ${what} at ${cents(paid || q.own)} (${usd(+(filled * (paid || q.own)).toFixed(2))})` : "",
      resting ? `${filled ? "" : `order for ${what}: `}${resting} resting at ${cents(q.own)} (order ${r.order_id})` : "",
      ask.market && left > 0 ? `${left} of the ${ask.count} didn't fill within ${cents(ask.slippage)} of the offer and ${left === 1 ? "was" : "were"} cancelled` : "",
    ].filter(Boolean);
    if (!filled && !resting) return `Kalshi: nothing filled: nobody was offering ${what} within ${cents(ask.slippage)} of ${cents(q.own - ask.slippage)}; the order was cancelled.`;
    return `Kalshi: ${parts.join("; ")}.`;
  }

  /** The account in words: cash, what's open, what's resting. */
  async accountText(): Promise<string> {
    const s = await this.status(true);
    if (!s.trading) return `Kalshi: ${s.problem}`;
    const [pos, orders] = await Promise.all([this.positions(), this.resting()]);
    const lines = [`Kalshi: ${usd(s.balance ?? 0)} cash, positions worth ${usd(s.portfolio ?? 0)}.`];
    lines.push(pos.length ? `Positions (${pos.length}):\n${pos.slice(0, 40).map((p) => { const n = num(p.position_fp); return `- ${p.ticker}: ${Math.abs(n)} ${n > 0 ? "YES" : "NO"}, cost ${usd(Math.abs(num(p.market_exposure_dollars)))}${num(p.realized_pnl_dollars) ? `, realized ${num(p.realized_pnl_dollars) > 0 ? "+" : "-"}${usd(Math.abs(num(p.realized_pnl_dollars)))}` : ""}`; }).join("\n")}` : "No open positions.");
    if (orders.length) lines.push(`Resting orders (${orders.length}):\n${orders.slice(0, 30).map((o) => `- ${o.ticker}: buy ${num(o.remaining_count_fp)} ${String(o.outcome_side ?? "yes").toUpperCase()} at ${cents(num(o.outcome_side === "no" ? o.no_price_dollars : o.yes_price_dollars))} (order ${o.order_id})`).join("\n")}`);
    return lines.join("\n");
  }

  tools(): ToolDef[] {
    return [
      defineTool({
        name: "kalshi_trading",
        description: "Whether HQ can trade on Phil's Kalshi account, the parameters he set (whether Cat trades on her own, the caps), what was traded today, and how to file a trade or ask for a parameter change.",
        schema: {},
        handler: async () => {
          const s = await this.status();
          if (!s.trading) return `Kalshi trading is off: ${s.problem}.`;
          const l = s.limits;
          const spent = await this.store.settings.get<{ day: string; usd: number }>(SPENT_KEY, { day: day(), usd: 0 });
          const own = l.auto && !kalshiAutoMissing(l).length
            ? `You trade on your own. A trade block inside these parameters is placed the moment HQ reads it, and Phil is told; one that would take everything open past the cap becomes a card for Phil (over the per-order or daily cap it's refused). Closing a position and cancelling an order HQ placed always go through. Traded today: ${usd(spent.day === day() ? spent.usd : 0)} of ${usd(l.maxDayUsd ?? 0)}.`
            : "Phil can let you trade on your own in Settings › Kalshi, or you can ask with a kalshi.params card.";
          return `Kalshi trading is on: ${usd(s.balance ?? 0)} cash, positions worth ${usd(s.portfolio ?? 0)}. ${kalshiLimitsText(l)}\n${own}\n${KalshiTrader.promptHint()}`;
        },
      }),
      defineTool({
        name: "kalshi_account",
        description: "Phil's Kalshi account right now: cash, every open position (contracts, side, what it cost), and resting orders.",
        schema: {},
        handler: async () => { try { return await this.accountText(); } catch (e) { return `Kalshi: ${(e as Error).message}`; } },
      }),
    ];
  }

  executors(): Record<string, Executor> {
    return {
      "kalshi.order": (a) => this.serial(() => this.placeOrderNow(a)),
      // Out of a position, at market: reduce-only, so it can never open one the other way.
      "kalshi.close": (a) => this.serial(async () => {
        await this.ready();
        const p = (a.payload ?? {}) as Record<string, unknown>;
        const ticker = String(p.ticker ?? "").trim().toUpperCase();
        const pos = (await this.positions(ticker)).find((x) => x.ticker.toUpperCase() === ticker);
        const have = num(pos?.position_fp);
        if (!have) throw new Error(`there's no open position on ${ticker} to close`);
        const pct = closePct(p.pct);
        const count = Math.max(1, Math.floor((Math.abs(have) * pct) / 100));
        let slip = num(p.slippage); if (slip >= 1) slip = slip / 100; slip = Math.min(Math.max(slip || 0.02, 0.01), 0.1);
        const m = await this.market(ticker);
        const yesBid = num(m.yes_bid_dollars), yesAsk = num(m.yes_ask_dollars);
        // Holding YES: sell it into the bids. Holding NO: buy YES back from the offers (which nets the NO away).
        const sellYes = have > 0;
        if (sellYes ? !(yesBid > 0) : !(yesAsk > 0 && yesAsk < 1)) throw new Error(`nobody is bidding for ${sellYes ? "YES" : "NO"} on ${ticker} right now, so it can't be closed at market`);
        const yes = snapPrice(sellYes ? Math.max(yesBid - slip, 0.0001) : Math.min(yesAsk + slip, 0.9999), m.price_ranges, sellYes ? "down" : "up");
        const r = await this.call<{ order_id: string; fill_count?: string; remaining_count?: string; average_fill_price?: string }>("POST", "/portfolio/events/orders", { ticker: m.ticker, side: sellYes ? "ask" : "bid", count: count.toFixed(2), price: yes.toFixed(4), time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross", reduce_only: true, client_order_id: `hq-${a.id}`.slice(0, 64) });
        this.ok = undefined;
        const filled = num(r.fill_count);
        if (!filled) throw new Error(`nothing filled within ${cents(slip)} of the best bid; the ${ticker} position is unchanged`);
        const got = sellYes ? num(r.average_fill_price) : 1 - num(r.average_fill_price);
        return `Kalshi: sold ${filled} ${sellYes ? "YES" : "NO"} on ${ticker} at ${cents(got)} (${usd(+(filled * got).toFixed(2))} back)${filled < count ? `; ${count - filled} didn't fill and ${count - filled === 1 ? "is" : "are"} still held` : ""}${pct < 100 ? `, ${pct}% of the position` : ""}.`;
      }),
      "kalshi.cancel": async (a) => {
        await this.ready();
        const p = (a.payload ?? {}) as Record<string, unknown>;
        const ticker = String(p.ticker ?? "").trim().toUpperCase();
        if (!ticker && !p.orderId) throw new Error('the card needs the market\'s "ticker" (or an "orderId")');
        let mine = (await this.resting(ticker || undefined)).filter((o) => !p.orderId || o.order_id === String(p.orderId));
        // Placed on her own: only orders HQ placed, never one Phil put in by hand.
        if (/^auto:/.test(a.note ?? "")) { const ours = await this.store.settings.get<string[]>(OURS_KEY, []); mine = mine.filter((o) => ours.includes(o.order_id)); }
        if (!mine.length) throw new Error(`no resting order${p.orderId ? ` ${String(p.orderId)}` : ""}${ticker ? ` on ${ticker}` : ""}`);
        for (const o of mine) await this.call("DELETE", `/portfolio/events/orders/${encodeURIComponent(o.order_id)}?market_ticker=${encodeURIComponent(o.ticker)}`);
        return `Kalshi: cancelled ${mine.length} order${mine.length === 1 ? "" : "s"}${ticker ? ` on ${ticker}` : ""}.`;
      },
      // A change to the parameters: only ever on Phil's approval (rules.ts never lets a kalshi.* card run alone).
      "kalshi.params": async (a) => {
        const p = (a.payload ?? {}) as Record<string, unknown>;
        const cur = await this.limits();
        const pick = <K extends keyof KalshiLimits>(k: K) => (k in p ? (p[k] as KalshiLimits[K]) : cur[k]);
        return `Kalshi parameters now: ${kalshiLimitsText(await this.setLimits({ auto: pick("auto"), maxOrderUsd: pick("maxOrderUsd"), maxDayUsd: pick("maxDayUsd"), maxOpenUsd: pick("maxOpenUsd") }))}`;
      },
    };
  }

  /** What Phil reads on the card: the order as it will go out, and the most it can lose. */
  describe(): Record<string, Describer> {
    const real = "Real money on your Kalshi account, the moment you approve.";
    return {
      "kalshi.order": (p) => {
        try {
          const a = readKalshiOrder(p);
          const at = a.market ? `at market (within ${cents(a.slippage)} of the best offer, or not at all)` : `at ${cents(a.price!)} each, resting until filled or cancelled`;
          return `Buys ${a.count} ${a.side.toUpperCase()} contract${a.count === 1 ? "" : "s"} on ${a.ticker} ${at}.${a.price ? ` Costs ${usd(+(a.count * a.price).toFixed(2))} at most, which is also the most it can lose; pays ${usd(a.count)} if ${a.side.toUpperCase()} wins.` : ` Each pays $1 if ${a.side.toUpperCase()} wins; the most it can lose is what it costs.`} ${real}`;
        } catch (e) { return `This order can't be read: ${(e as Error).message}.`; }
      },
      "kalshi.close": (p) => `Sells ${closePct(p.pct) < 100 ? `${closePct(p.pct)}% of ` : ""}your position on ${String(p.ticker ?? "?").toUpperCase()} at market (reduce-only: it can only shrink the position). ${real}`,
      "kalshi.cancel": (p) => `Cancels ${p.orderId ? `order ${String(p.orderId)}` : "every resting order"}${p.ticker ? ` on ${String(p.ticker).toUpperCase()}` : ""} on Kalshi.`,
      "kalshi.params": (p) => {
        const names: Record<string, string> = { auto: "Cat trades on her own", maxOrderUsd: "per-order cap ($)", maxDayUsd: "daily cap ($)", maxOpenUsd: "cap on everything open ($)" };
        const parts = Object.keys(names).filter((k) => k in p).map((k) => `${names[k]}: ${p[k] === true ? "yes" : p[k] === false ? "no" : p[k] ? String(p[k]) : "none"}`);
        return `Changes your Kalshi trading parameters. ${parts.length ? parts.join("; ") : "Nothing named to change"}. Everything not named stays as it is.`;
      },
    };
  }

  static promptHint(): string {
    return 'Kalshi trading is connected. kalshi_trading says whether you trade on your own inside Phil\'s parameters or every order waits for his card; either way a trade is the same approval block of kind "money": {"kind":"money","title":"Buy <N> <YES|NO> <ticker>","body":"<what the market asks, your odds against the price, and what would prove you wrong, in a few lines>","payload":{"action":"kalshi.order","ticker":"<market ticker, exactly>","side":"yes|no","count":<whole contracts>,"type":"limit|market","price":<limit only: that side\'s price, 0.56 or 56 for 56¢>}}. A contract pays $1 if its side wins and costs its price, so the cost is the most it can lose. To get out of a position: {"action":"kalshi.close","ticker":"...","pct":100}; to cancel resting orders: {"action":"kalshi.cancel","ticker":"...","orderId":<optional>}. To ask Phil to change a parameter, a block of kind "config": {"action":"kalshi.params", plus only what changes: "auto":true|false, "maxOrderUsd", "maxDayUsd", "maxOpenUsd"}, with why in the body. Check kalshi_account first, and take the ticker from prediction_markets or Kalshi itself, never from memory.';
  }
}
