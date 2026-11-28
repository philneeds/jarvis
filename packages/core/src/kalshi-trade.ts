import { constants, createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
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
 *   - a market holds one net position, so an "ask" while holding YES sells that YES rather than buying NO: an order
 *     against a position already held is refused here, and getting out is kalshi.close
 *   - prices are dollar strings ("0.5600") on the market's own grid (price_ranges), counts are strings ("10.00")
 *   - every request is signed: timestamp + METHOD + path, RSA-PSS/SHA-256 (or Ed25519), three KALSHI-ACCESS headers
 *   KALSHI_API_KEY_ID         the key's id (Kalshi › Account & security › API Keys)
 *   KALSHI_PRIVATE_KEY_FILE   the path of the .pem Kalshi gave when the key was made (or KALSHI_PRIVATE_KEY, the PEM
 *                             itself with \n for line breaks)
 *   KALSHI_API_BASE           optional, e.g. the demo host; production by default
 * A key with the scopes "read" and "write::trade" can read the account and place and cancel orders, and nothing
 * else: it can't move money between accounts or make keys. Kalshi's API has no withdrawal for a member account.
 * What HQ wires in: an order to buy YES or NO, closing a position (reduce-only), cancelling a resting order, and the
 * parameters. The most a contract can lose is what it cost (with Kalshi's fee), so the caps are in dollars of cost:
 * per order, per day, and in all positions and resting orders together.
 * The first version was reviewed before anyone used it (Nov 23); what that found is fixed here and noted where.
 */
const BASE = "https://external-api.kalshi.com/trade-api/v2";
const LIMITS_KEY = "kalshi.limits";
const SPENT_KEY = "kalshi.spent";
/** Resting orders HQ placed (with what each contract was counted at), so a cancel on her own never touches one Phil placed by hand and gives the day's count back. */
const OURS_KEY = "kalshi.ourOrders";
/** Markets HQ bought into, so closing on her own never sells a position Phil opened himself. */
const OUR_TICKERS_KEY = "kalshi.ourTickers";
const TIMEOUT_MS = 20_000;

/** The request's outcome isn't known: no answer in time, or Kalshi's own error. An order sent this way may have gone out. */
class Unsure extends Error {}
/** Kalshi said "too many requests"; `waitMs` is how long it asked HQ to wait, when it said. */
class RateLimited extends Error { constructor(readonly waitMs?: number) { super("Kalshi's rate limit is hit; try again in a moment"); } }

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
/** Kalshi's fee on one contract at price p, rounded up to the cent: counted in an order's cost so the caps aren't understated. */
const feeEach = (p: number) => Math.ceil(7 * p * (1 - p) - 1e-9) / 100;
/** How much of a position a close card means: nothing said is all of it; anything that isn't 1 to 100 is refused, not guessed. */
function readPct(v: unknown): number {
  if (v === undefined || v === null || v === "") return 100;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`"pct" is a whole number from 1 to 100, not "${String(v)}"`);
  return n;
}
function readSlip(v: unknown): number { let s = num(v); if (s >= 1) s = s / 100; return Math.min(Math.max(s || 0.02, 0.01), 0.1); }

/** What a card asks for: buy YES or NO contracts of a market, at a limit price (of that side) or at market. */
export interface KalshiAsk { ticker: string; side: "yes" | "no"; count: number; price?: number; market: boolean; slippage: number }
export function readKalshiOrder(p: Record<string, unknown>): KalshiAsk {
  const ticker = String(p.ticker ?? "").trim().toUpperCase();
  if (!ticker) throw new Error('the card needs the market\'s "ticker"');
  const side = String(p.side ?? "").trim().toLowerCase();
  if (side !== "yes" && side !== "no") throw new Error('the card needs "side": yes or no (the outcome to buy)');
  const count = num(p.count);
  if (!Number.isInteger(count) || count < 1) throw new Error('the card needs "count": a whole number of contracts');
  // A price is the price of the side being bought, in dollars (0.56) or cents (56).
  let price = p.price === undefined || p.price === null || p.price === "" ? undefined : num(String(p.price).replace(/[$¢\s]/g, ""));
  if (price !== undefined && price >= 1 && price < 100) price = price / 100;
  if (price !== undefined && !(price > 0 && price < 1)) throw new Error("the price is a contract's price: between 1¢ and 99¢");
  // Exactly "limit" or "market": anything else ("gtc", "limit order") used to become a market order with its price dropped.
  const type = p.type === undefined || p.type === null || p.type === "" ? (price === undefined ? "market" : "limit") : String(p.type).trim().toLowerCase();
  if (type !== "limit" && type !== "market") throw new Error(`"type" is limit or market, not "${String(p.type)}"`);
  if (type === "limit" && price === undefined) throw new Error("a limit order needs its price");
  if (type === "market" && price !== undefined) throw new Error('a market order has no price: use "type":"limit" to name one');
  return { ticker, side, count, price, market: type === "market", slippage: readSlip(p.slippage) };
}

type Range = { start: string; end: string; step: string };
interface KMarket { ticker: string; title?: string; status?: string; market_type?: string; yes_bid_dollars?: string; yes_ask_dollars?: string; price_ranges?: Range[]; close_time?: string }
interface KPosition { ticker: string; position_fp?: string; market_exposure_dollars?: string; realized_pnl_dollars?: string }
interface KOrder { order_id: string; client_order_id?: string; ticker: string; outcome_side?: "yes" | "no"; status?: string; yes_price_dollars?: string; no_price_dollars?: string; remaining_count_fp?: string; fill_count_fp?: string }
type Sent = { order_id: string; filled: number; left: number; avg?: number; fee: number };
type Ours = { id: string; own?: number; day?: string; ticker?: string };

const gridOf = (ranges?: Range[]) => (ranges?.length ? ranges : [{ start: "0.0000", end: "1.0000", step: "0.0100" }]);
/** The lowest and highest prices an order can carry on this grid (0 and 1 themselves are refused by Kalshi). */
export function tickBounds(ranges?: Range[]): { lo: number; hi: number } {
  const rs = gridOf(ranges), first = rs[0]!, last = rs[rs.length - 1]!;
  return { lo: +(num(first.start) <= 0 ? num(first.start) + (num(first.step) || 0.01) : num(first.start)).toFixed(4), hi: +(num(last.end) >= 1 ? num(last.end) - (num(last.step) || 0.01) : num(last.end)).toFixed(4) };
}
/** A YES price put on the market's grid: the nearest tick, or the next one up or down, never 0 or 1. */
export function snapPrice(p: number, ranges: Range[] | undefined, dir: "up" | "down" | "near"): number {
  const rs = gridOf(ranges);
  const r = rs.find((x) => p >= num(x.start) - 1e-9 && p <= num(x.end) + 1e-9) ?? (p < num(rs[0]!.start) ? rs[0]! : rs[rs.length - 1]!);
  const start = num(r.start), step = num(r.step) || 0.01;
  const k = (p - start) / step;
  const n = dir === "up" ? Math.ceil(k - 1e-6) : dir === "down" ? Math.floor(k + 1e-6) : Math.round(k);
  const { lo, hi } = tickBounds(ranges);
  return +Math.min(Math.max(start + n * step, lo), hi).toFixed(4);
}

export class KalshiTrader {
  readonly id = "kalshi-trade";
  private queue: Promise<unknown> = Promise.resolve();
  private ok?: { at: number; v: { trading: boolean; problem?: string; balance?: number; portfolio?: number } };
  /** Orders just sent: Kalshi's lists can lag a write by a moment, so the open cap counts these itself for a while. */
  private recent: { at: number; usd: number }[] = [];
  constructor(private store: Store, private opts: { keyId: string; key: KeyObject; base?: string; fetch?: typeof fetch; now?: () => number; retryMs?: number; /** The beat between requests (tests set 0). */ gapMs?: number }) {}
  private now() { return (this.opts.now ?? Date.now)(); }

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
    const ts = String(this.now());
    const msg = Buffer.from(`${ts}${method}${path}`);
    const sig = this.opts.key.asymmetricKeyType === "ed25519"
      ? cryptoSign(null, msg, this.opts.key)
      : cryptoSign("sha256", msg, { key: this.opts.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
    return { "KALSHI-ACCESS-KEY": this.opts.keyId, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sig.toString("base64") };
  }
  /**
   * One request to Kalshi at a time, a beat apart. The first real run (Nov 27 2026) had an agent's tools read the
   * balance, positions and orders side by side, and Kalshi answered "too many requests" to one of them, which read
   * as "trading is off". Nothing here is urgent enough to need two requests in the air at once.
   */
  private balancing?: Promise<{ balance?: number; balance_dollars?: string; portfolio_value?: number }>;
  private gate: Promise<unknown> = Promise.resolve();
  private lastCall = 0;
  private pause(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
  private paced<T>(fn: () => Promise<T>): Promise<T> {
    const gap = this.opts.gapMs ?? 150;
    const run = this.gate.catch(() => undefined).then(async () => {
      const wait = this.lastCall + gap - Date.now();
      if (wait > 0) await this.pause(wait);
      try { return await fn(); } finally { this.lastCall = Date.now(); }
    });
    this.gate = run;
    return run;
  }
  /**
   * A read that Kalshi turns away for coming too fast waits as long as Kalshi says (a second or two, five at most)
   * and asks again, three tries in all. An order or a cancel is never sent twice from here: a refusal goes back to
   * the caller, which knows what is safe.
   */
  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    for (let i = 0; ; i++) {
      try { return await this.paced(() => this.once<T>(method, path, body)); }
      catch (e) {
        if (!(e instanceof RateLimited) || method !== "GET" || i >= 2) throw e;
        await this.pause(Math.min(e.waitMs ?? (this.opts.retryMs ?? 1000) * (i + 1), 5000));
      }
    }
  }
  private async once<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const url = new URL(`${this.opts.base ?? BASE}${path}`);
    // Signed over the path from the API's root, without the query. A request that hangs is given up on, so one stuck
    // call can't hold every order behind it.
    let res: Response;
    try { res = await (this.opts.fetch ?? fetch)(url, { method, headers: { ...this.headers(method, url.pathname), accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch (e) { throw new Unsure(`Kalshi didn't answer (${(e as Error).message.slice(0, 80)})`); }
    const j = (await res.json().catch(() => undefined)) as (T & { error?: { code?: string; message?: string; details?: string }; code?: string; message?: string; details?: string }) | undefined;
    if (res.ok) { if (j === undefined) throw new Unsure("Kalshi's answer couldn't be read"); return j; }
    const e = j?.error ?? j ?? {};
    const said = [e.code, e.message, e.details].filter(Boolean).join(": ");
    const scope = /insufficient_scope:_?([a-z_:]+?)_required/.exec(String(e.code ?? ""));
    if (res.status === 403 && scope) throw new Error(`Kalshi's key lacks the "${scope[1]}" permission; make a key with read and trade access`);
    if (res.status === 401) throw new Error(`Kalshi refused the key (${said || "401"}); check KALSHI_API_KEY_ID and the .pem, and the server's clock`);
    if (res.status === 429) { const s = Number(res.headers.get("retry-after")); throw new RateLimited(Number.isFinite(s) && s > 0 ? s * 1000 : undefined); }
    if (res.status === 408 || res.status >= 500) throw new Unsure(`Kalshi answered ${res.status}${said ? `: ${said}` : ""}`);
    throw new Error(`Kalshi answered ${res.status}${said ? `: ${said}` : ""}`);
  }
  /** Every page of a list (a cap that reads only the first page can be walked past). */
  private async pages<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor = "";
    for (let i = 0; i < 30; i++) {
      const j = await this.call<Record<string, unknown>>("GET", `${path}${path.includes("?") ? "&" : "?"}limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...((j[key] as T[] | undefined) ?? []));
      cursor = typeof j.cursor === "string" ? j.cursor : "";
      if (!cursor) return out;
    }
    throw new Error("Kalshi's list has more pages than HQ will read; nothing is assumed about the rest");
  }

  async limits(): Promise<KalshiLimits> { return this.store.settings.get<KalshiLimits>(LIMITS_KEY, {}); }
  /** The parameters, as Phil set them in Settings or approved on a card. Trading on her own needs every cap. */
  async setLimits(l: KalshiLimits): Promise<KalshiLimits> {
    const clean = (v: unknown, what: string) => {
      if (v === undefined || v === null || v === 0 || (typeof v === "string" && !v.trim())) return undefined;
      const n = Number(String(v).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a number, not "${String(v)}"`);
      // Under a dollar would round to "no cap": refused, not read as none.
      if (n > 0 && n < 1) throw new Error(`${what} must be at least $1 (or empty for none), not ${String(v)}`);
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

  /**
   * Whether the key works, and what the account holds. A good answer is kept for half a minute; a refused key is kept
   * too. A passing problem (the rate limit, no answer) is not: one hiccup mustn't switch trading off for the next card.
   */
  async status(fresh = false): Promise<{ trading: boolean; problem?: string; balance?: number; portfolio?: number; transient?: boolean; limits: KalshiLimits }> {
    const limits = await this.limits();
    const now = this.now();
    if (!fresh && this.ok && now - this.ok.at < 30_000) return { ...this.ok.v, limits };
    try {
      // One balance read in the air at a time: an agent's tools ask "is trading on" and "what's in the account" in
      // the same moment, and both ride on this call.
      this.balancing ??= this.call<{ balance?: number; balance_dollars?: string; portfolio_value?: number }>("GET", "/portfolio/balance").finally(() => { this.balancing = undefined; });
      const b = await this.balancing;
      const v = { trading: true, balance: b.balance_dollars !== undefined ? num(b.balance_dollars) : num(b.balance) / 100, portfolio: num(b.portfolio_value) / 100 };
      this.ok = { at: now, v };
      return { ...v, limits };
    } catch (e) {
      const transient = e instanceof Unsure || /rate limit/.test((e as Error).message);
      const v = { trading: false, problem: (e as Error).message };
      if (!transient) this.ok = { at: now, v };
      return { ...v, transient, limits };
    }
  }
  /** Before an order: a refused key stops it; a passing problem on the balance call doesn't (the order itself will say). */
  private async ready(): Promise<void> {
    const s = await this.status();
    if (!s.trading && !s.transient) throw new Error(s.problem ?? "Kalshi trading isn't set up");
  }

  async market(ticker: string): Promise<KMarket> {
    const j = await this.call<{ market?: KMarket }>("GET", `/markets/${encodeURIComponent(ticker)}`);
    if (!j.market?.ticker) throw new Error(`${ticker} isn't a Kalshi market`);
    return j.market;
  }
  private async positions(ticker?: string): Promise<KPosition[]> {
    return (await this.pages<KPosition>(`/portfolio/positions?count_filter=position${ticker ? `&ticker=${encodeURIComponent(ticker)}` : ""}`, "market_positions")).filter((p) => num(p.position_fp) !== 0);
  }
  private async resting(ticker?: string): Promise<KOrder[]> {
    return this.pages<KOrder>(`/portfolio/orders?status=resting${ticker ? `&ticker=${encodeURIComponent(ticker)}` : ""}`, "orders");
  }
  /** Dollars at risk now: what open positions cost, what resting orders would cost if they filled, and what was just sent. */
  private async openUsd(): Promise<number> {
    const [pos, orders] = await Promise.all([this.positions(), this.resting()]);
    const held = pos.reduce((t, p) => t + Math.abs(num(p.market_exposure_dollars)), 0);
    const waiting = orders.reduce((t, o) => t + num(o.remaining_count_fp) * num(o.outcome_side === "no" ? o.no_price_dollars : o.yes_price_dollars), 0);
    const now = this.now();
    this.recent = this.recent.filter((r) => now - r.at < 15_000);
    return held + waiting + this.recent.reduce((t, r) => t + r.usd, 0);
  }

  /**
   * The order as it would go out. Kalshi quotes one book from the YES side, so buying NO at q is sent as "ask"
   * (sell YES) at 1 − q. A market order is an immediate-or-cancel limit a little past the best offer. Its cost
   * includes Kalshi's fee, rounded up.
   */
  async plan(ask: KalshiAsk) {
    const m = await this.market(ask.ticker);
    if (m.status && m.status !== "active") throw new Error(`${m.ticker} isn't trading (it is ${m.status})`);
    if (m.market_type && m.market_type !== "binary") throw new Error(`${m.ticker} is a ${m.market_type} market, which doesn't pay a flat $1; HQ only trades yes/no markets`);
    // One net position per market: an order against what's held would sell it, not open the other side.
    const have = num((await this.positions(m.ticker)).find((p) => p.ticker.toUpperCase() === m.ticker.toUpperCase())?.position_fp);
    if ((have > 0 && ask.side === "no") || (have < 0 && ask.side === "yes")) throw new Error(`you hold ${Math.abs(have)} ${have > 0 ? "YES" : "NO"} on ${m.ticker}: buying ${ask.side.toUpperCase()} there would sell ${have > 0 ? "that YES" : "that NO"} rather than open a new position. Close it first (kalshi.close)`);
    const { lo, hi } = tickBounds(m.price_ranges);
    const yesAsk = num(m.yes_ask_dollars), yesBid = num(m.yes_bid_dollars);
    let own: number; // the price of the side being bought
    if (ask.market) {
      const offer = ask.side === "yes" ? yesAsk : yesBid > 0 ? 1 - yesBid : 0;
      if (!(offer > 0 && offer < 1)) throw new Error(`nobody is offering ${ask.side.toUpperCase()} on ${m.ticker} right now; give a limit price`);
      own = offer + ask.slippage;
    } else own = ask.price!;
    // On the grid, from the YES side: a market order moves to the next tick that still fills (never past the last
    // one); a limit must already be on one.
    const yesRaw = ask.side === "yes" ? own : 1 - own;
    const yes = snapPrice(Math.min(Math.max(yesRaw, lo), hi), m.price_ranges, ask.market ? (ask.side === "yes" ? "up" : "down") : "near");
    if (!ask.market && Math.abs(yes - yesRaw) > 1e-9) { const near = ask.side === "yes" ? yes : +(1 - yes).toFixed(4); throw new Error(`${m.ticker} prices go in steps: ${cents(own)} isn't one; the nearest is ${cents(near)}`); }
    own = ask.side === "yes" ? yes : +(1 - yes).toFixed(4);
    const fee = +(ask.count * feeEach(own)).toFixed(2), cost = +(ask.count * own).toFixed(4);
    return { m, own, cost, fee, total: +(cost + fee).toFixed(4), body: { ticker: m.ticker, side: ask.side === "yes" ? "bid" : "ask", count: ask.count.toFixed(2), price: yes.toFixed(4), time_in_force: ask.market ? "immediate_or_cancel" : "good_till_canceled", self_trade_prevention_type: "taker_at_cross" } };
  }

  /** Over the per-order or daily cap (with the fee): refused. */
  private async overCaps(total: number): Promise<string | undefined> {
    const l = await this.limits();
    if (l.maxOrderUsd && total > l.maxOrderUsd) return `${usd(total)} (with Kalshi's fee) is over the ${usd(l.maxOrderUsd)} per-order cap.`;
    const spent = await this.store.settings.get<{ day: string; usd: number }>(SPENT_KEY, { day: day(), usd: 0 });
    const today = spent.day === day() ? spent.usd : 0;
    if (l.maxDayUsd && today + total > l.maxDayUsd) return `that would take today to ${usd(+(today + total).toFixed(2))}, over the ${usd(l.maxDayUsd)} daily cap.`;
    return undefined;
  }
  /** Refused before Phil sees it: a market that isn't trading, a price off the grid, an order against a position held, or over a cap he set. */
  async preflight(a: Omit<Approval, "id" | "at" | "status">): Promise<string | undefined> {
    const p = (a.payload ?? {}) as Record<string, unknown>;
    if (p.action === "kalshi.close") { try { readPct(p.pct); return undefined; } catch (e) { return (e as Error).message; } }
    if (p.action !== "kalshi.order") return undefined;
    try { return await this.overCaps((await this.plan(readKalshiOrder(p))).total); } catch (e) { return (e as Error).message; }
  }

  /** For HQ's approval flow: run this card now, or leave it for Phil and say why on it (nothing to say for other cards). */
  async runsAlone(a: Pick<Approval, "agentId" | "payload">): Promise<{ ok: boolean; why?: string }> {
    let why: string | undefined;
    try { why = await this.autoRefusal(a); } catch (e) { why = `it couldn't be checked (${(e as Error).message})`; }
    if (!why) return { ok: true, why: "inside your Kalshi trading parameters" };
    return { ok: false, why: /^(not a Kalshi trade|only Cat|trading on her own is off)/.test(why) ? undefined : `${NOT_PLACED}${why}` };
  }
  /**
   * Undefined when a card may run without Phil (Cat's, on, inside every cap); else why not. On her own she only gets
   * out of positions HQ got into and only cancels orders HQ placed: anything Phil did by hand is his call.
   */
  async autoRefusal(a: Pick<Approval, "agentId" | "payload">, planned?: { total: number }): Promise<string | undefined> {
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
    const ticker = String(p.ticker ?? "").trim().toUpperCase();
    if (action === "kalshi.close") {
      const ours = await this.store.settings.get<string[]>(OUR_TICKERS_KEY, []);
      return ours.includes(ticker) ? undefined : `the position on ${ticker || "that market"} wasn't opened by HQ (yours, by hand?), so closing it is your call`;
    }
    if (action === "kalshi.cancel") {
      const ours = await this.ours();
      const hit = (await this.resting(ticker || undefined)).filter((o) => !p.orderId || o.order_id === String(p.orderId));
      const theirs = hit.filter((o) => !ours.some((x) => x.id === o.order_id));
      return theirs.length ? `${theirs.length === 1 ? "an order" : `${theirs.length} orders`} there weren't placed by HQ (yours, by hand?), so cancelling ${theirs.length === 1 ? "it" : "them"} is your call` : undefined;
    }
    const q = planned ?? (await this.plan(readKalshiOrder(p)));
    const open = await this.openUsd();
    if (open + q.total > l.maxOpenUsd!) return `it would take everything open to ${usd(+(open + q.total).toFixed(2))}, over your ${usd(l.maxOpenUsd!)} cap`;
    return undefined;
  }

  private async ours(): Promise<Ours[]> { return (await this.store.settings.get<(string | Ours)[]>(OURS_KEY, [])).map((x) => (typeof x === "string" ? { id: x } : x)); }
  private async tally(cost: number) {
    const s = await this.store.settings.get<{ day: string; usd: number }>(SPENT_KEY, { day: day(), usd: 0 });
    await this.store.settings.set(SPENT_KEY, { day: day(), usd: +Math.max(0, (s.day === day() ? s.usd : 0) + cost).toFixed(2) });
  }
  private async bought(ticker: string) {
    const t = await this.store.settings.get<string[]>(OUR_TICKERS_KEY, []);
    if (!t.includes(ticker)) await this.store.settings.set(OUR_TICKERS_KEY, [...t, ticker].slice(-400));
  }
  /** One order at a time, so two cards approved together can't both slip under a cap before either is counted. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
  /** Unique to the card and to what it asks, so two steps of one batch card don't collide. */
  private clientId(a: Approval, payload: Record<string, unknown>): string {
    return `hq-${a.id}-${createHash("sha1").update(JSON.stringify(Object.entries(payload).sort(([x], [y]) => x.localeCompare(y)))).digest("hex").slice(0, 8)}`.slice(0, 64);
  }
  /**
   * Send an order. When Kalshi doesn't answer or answers with its own error, the order may still have gone out: HQ
   * looks for it by its id before saying anything, and if it still can't tell, says exactly that (Unsure).
   */
  private async send(body: Record<string, unknown>, ticker: string, cid: string): Promise<Sent> {
    try {
      const r = await this.call<{ order_id?: string; fill_count?: string; remaining_count?: string; average_fill_price?: string; average_fee_paid?: string }>("POST", "/portfolio/events/orders", { ...body, client_order_id: cid });
      if (!r.order_id) throw new Unsure("Kalshi's answer had no order in it");
      return { order_id: r.order_id, filled: num(r.fill_count), left: num(r.remaining_count), avg: r.average_fill_price !== undefined && r.average_fill_price !== "" ? num(r.average_fill_price) : undefined, fee: num(r.average_fee_paid) };
    } catch (e) {
      if (!(e instanceof Unsure)) throw e;
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, this.opts.retryMs ?? 1500));
        const found = await this.call<{ orders?: KOrder[] }>("GET", `/portfolio/orders?ticker=${encodeURIComponent(ticker)}&limit=200`).then((j) => j.orders?.find((o) => o.client_order_id === cid)).catch(() => undefined);
        if (found) return { order_id: found.order_id, filled: num(found.fill_count_fp), left: num(found.remaining_count_fp), fee: 0 };
      }
      throw e;
    }
  }
  private async placeOrderNow(a: Approval): Promise<string> {
    await this.ready();
    const payload = (a.payload ?? {}) as Record<string, unknown>;
    const ask = readKalshiOrder(payload);
    // One plan: the caps are checked on the very order that goes out.
    const q = await this.plan(ask);
    const over = await this.overCaps(q.total);
    if (over) throw new Error(over);
    // Placed on her own: checked once more now, in line behind any order before it.
    if (/^auto:/.test(a.note ?? "")) { const why = await this.autoRefusal(a, q); if (why) throw new Error(`${NOT_PLACED}${why}`); }
    const what = `${ask.side.toUpperCase()} on ${q.m.ticker}`;
    let r: Sent;
    try { r = await this.send(q.body, q.m.ticker, this.clientId(a, payload)); }
    catch (e) {
      if (!(e instanceof Unsure)) throw e;
      // Not known either way: counted as if it went out, so the caps can't be walked past on a bad connection.
      await this.tally(q.total); await this.bought(q.m.ticker); this.recent.push({ at: this.now(), usd: q.total });
      throw new Error(`${e.message}. The order for ${ask.count} ${what} MAY have gone out: check kalshi_account before trying again. It is counted against today's cap in case it did`);
    }
    const filled = r.filled, resting = ask.market ? 0 : r.left;
    // The fill price comes back from the YES side: a NO bought at q filled at 1 − q there.
    const paid = r.avg !== undefined ? (ask.side === "yes" ? r.avg : +(1 - r.avg).toFixed(4)) : q.own;
    const fees = +(filled * r.fee).toFixed(2), each = q.own + feeEach(q.own);
    const counted = +(filled * paid + fees + resting * each).toFixed(2);
    await this.tally(counted);
    this.recent.push({ at: this.now(), usd: counted });
    if (filled || resting) await this.bought(q.m.ticker);
    if (resting > 0) await this.store.settings.set(OURS_KEY, [...(await this.ours()), { id: r.order_id, own: each, day: day(), ticker: q.m.ticker }].slice(-300));
    const missed = ask.count - filled;
    if (!filled && !resting) return ask.market
      ? `Kalshi: nothing filled: nobody was offering ${what} within ${cents(ask.slippage)} of the best offer; the order was cancelled.`
      : `Kalshi: the order for ${what} was cancelled as it arrived (it would have traded against an order of your own); nothing was placed.`;
    const parts = [
      filled ? `bought ${filled} ${what} at ${cents(paid)} (${usd(+(filled * paid).toFixed(2))}${fees ? ` plus ${usd(fees)} in fees` : ""})` : "",
      resting ? `${filled ? "" : `order for ${what}: `}${resting} resting at ${cents(q.own)} (order ${r.order_id})` : "",
      ask.market && missed > 0 ? `${missed} of the ${ask.count} didn't fill within ${cents(ask.slippage)} of the offer and ${missed === 1 ? "was" : "were"} cancelled` : "",
    ].filter(Boolean);
    return `Kalshi: ${parts.join("; ")}.`;
  }

  /** The account in words: cash, what's open, what's resting. */
  /** Everything the account holds, in dollars (cash plus positions at Kalshi's mark); undefined when it can't be read. */
  async total(): Promise<number | undefined> {
    const s = await this.status();
    return s.trading ? (s.balance ?? 0) + (s.portfolio ?? 0) : undefined;
  }
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
          // A passing problem is said as one: "trading is off" sent Cat and Phil looking for a fault that wasn't there.
          if (!s.trading && s.transient) return `Kalshi couldn't be checked just now (${s.problem}). That is a passing problem, not trading being off: the key and Phil's parameters are as they were. Call kalshi_trading again in a minute before filing anything.`;
          if (!s.trading) return `Kalshi trading is off: ${s.problem}.`;
          const l = s.limits;
          const spent = await this.store.settings.get<{ day: string; usd: number }>(SPENT_KEY, { day: day(), usd: 0 });
          const own = l.auto && !kalshiAutoMissing(l).length
            ? `You trade on your own. A trade block inside these parameters is placed the moment HQ reads it, and Phil is told; one that would take everything open past the cap becomes a card for Phil (over the per-order or daily cap it's refused). On your own you close positions HQ opened and cancel orders HQ placed; anything Phil did by hand is a card for him. Counted today: ${usd(spent.day === day() ? spent.usd : 0)} of ${usd(l.maxDayUsd ?? 0)}.`
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
        const pct = readPct(p.pct);
        const pos = (await this.positions(ticker)).find((x) => x.ticker.toUpperCase() === ticker);
        const have = num(pos?.position_fp), held = Math.abs(have);
        if (!have) throw new Error(`there's no open position on ${ticker} to close`);
        // All of it is all of it, a fraction of a contract included; a part is whole contracts.
        const count = pct === 100 ? held : Math.floor((held * pct) / 100);
        if (count < 1 && pct !== 100) throw new Error(`${pct}% of ${held} is less than one contract; close 100%`);
        const slip = readSlip(p.slippage);
        const m = await this.market(ticker);
        const { lo, hi } = tickBounds(m.price_ranges);
        const yesBid = num(m.yes_bid_dollars), yesAsk = num(m.yes_ask_dollars);
        // Holding YES: sell it into the bids. Holding NO: buy YES back from the offers (which nets the NO away).
        const sellYes = have > 0;
        if (sellYes ? !(yesBid > 0) : !(yesAsk > 0 && yesAsk < 1)) throw new Error(`nobody is bidding for ${sellYes ? "YES" : "NO"} on ${ticker} right now, so it can't be closed at market`);
        // Never 0 or 1: a nearly worthless position still closes at the last tick.
        const yes = snapPrice(Math.min(Math.max(sellYes ? yesBid - slip : yesAsk + slip, lo), hi), m.price_ranges, sellYes ? "down" : "up");
        let r: Sent;
        try { r = await this.send({ ticker: m.ticker, side: sellYes ? "ask" : "bid", count: count.toFixed(2), price: yes.toFixed(4), time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross", reduce_only: true }, m.ticker, this.clientId(a, p)); }
        catch (e) { if (e instanceof Unsure) throw new Error(`${e.message}. The close on ${ticker} MAY have gone through: check kalshi_account before trying again`); throw e; }
        if (!r.filled) throw new Error(`nothing filled within ${cents(slip)} of the best bid; the ${ticker} position is unchanged`);
        const got = r.avg !== undefined ? (sellYes ? r.avg : +(1 - r.avg).toFixed(4)) : sellYes ? yes : +(1 - yes).toFixed(4);
        const left = +(count - r.filled).toFixed(2);
        return `Kalshi: sold ${r.filled} ${sellYes ? "YES" : "NO"} on ${ticker} at ${cents(got)} (${usd(+(r.filled * got).toFixed(2))} back)${left > 0 ? `; ${left} didn't fill and ${left === 1 ? "is" : "are"} still held` : ""}${pct < 100 ? `, ${pct}% of the position` : ""}.`;
      }),
      "kalshi.cancel": async (a) => {
        await this.ready();
        const p = (a.payload ?? {}) as Record<string, unknown>;
        const ticker = String(p.ticker ?? "").trim().toUpperCase();
        if (!ticker && !p.orderId) throw new Error('the card needs the market\'s "ticker" (or an "orderId")');
        let mine = (await this.resting(ticker || undefined)).filter((o) => !p.orderId || o.order_id === String(p.orderId));
        const ours = await this.ours();
        // Placed on her own: only orders HQ placed, never one Phil put in by hand.
        if (/^auto:/.test(a.note ?? "")) mine = mine.filter((o) => ours.some((x) => x.id === o.order_id));
        if (!mine.length) throw new Error(`no resting order${p.orderId ? ` ${String(p.orderId)}` : ""}${ticker ? ` on ${ticker}` : ""}`);
        const done: string[] = [];
        let failed: string | undefined;
        for (const o of mine) {
          try {
            const r = await this.call<{ reduced_by?: string }>("DELETE", `/portfolio/events/orders/${encodeURIComponent(o.order_id)}?market_ticker=${encodeURIComponent(o.ticker)}`);
            done.push(o.order_id);
            // What a cancelled order was counted at goes back to the day it was counted in.
            const mineWas = ours.find((x) => x.id === o.order_id);
            if (mineWas?.own && mineWas.day === day()) await this.tally(-(num(r.reduced_by) * mineWas.own));
          } catch (e) { failed = (e as Error).message; break; }
        }
        if (done.length) await this.store.settings.set(OURS_KEY, ours.filter((x) => !done.includes(x.id)));
        if (failed) throw new Error(`${done.length ? `cancelled ${done.length} of ${mine.length}, then ` : ""}${failed}`);
        return `Kalshi: cancelled ${done.length} order${done.length === 1 ? "" : "s"}${ticker ? ` on ${ticker}` : ""}.`;
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
          const most = a.price ? ` Costs ${usd(+(a.count * a.price).toFixed(2))} at most plus Kalshi's fee (about ${usd(+(a.count * feeEach(a.price)).toFixed(2))}), which together is the most it can lose; pays ${usd(a.count)} if ${a.side.toUpperCase()} wins.` : ` Each pays $1 if ${a.side.toUpperCase()} wins; the most it can lose is what it costs, with Kalshi's fee.`;
          return `Buys ${a.count} ${a.side.toUpperCase()} contract${a.count === 1 ? "" : "s"} on ${a.ticker} ${at}.${most} ${real}`;
        } catch (e) { return `This order can't be read: ${(e as Error).message}.`; }
      },
      "kalshi.close": (p) => { try { const pct = readPct(p.pct); return `Sells ${pct < 100 ? `${pct}% of ` : ""}your position on ${String(p.ticker ?? "?").toUpperCase()} at market (reduce-only: it can only shrink the position). ${real}`; } catch (e) { return `This close can't be read: ${(e as Error).message}.`; } },
      "kalshi.cancel": (p) => `Cancels ${p.orderId ? `order ${String(p.orderId)}` : "every resting order"}${p.ticker ? ` on ${String(p.ticker).toUpperCase()}` : ""} on Kalshi.`,
      "kalshi.params": (p) => {
        const names: Record<string, string> = { auto: "Cat trades on her own", maxOrderUsd: "per-order cap ($)", maxDayUsd: "daily cap ($)", maxOpenUsd: "cap on everything open ($)" };
        const parts = Object.keys(names).filter((k) => k in p).map((k) => `${names[k]}: ${p[k] === true ? "yes" : p[k] === false ? "no" : p[k] && String(p[k]).trim() ? String(p[k]).trim() : "none"}`);
        return `Changes your Kalshi trading parameters. ${parts.length ? parts.join("; ") : "Nothing named to change"}. Everything not named stays as it is.`;
      },
    };
  }

  static promptHint(): string {
    return 'Kalshi trading is connected. kalshi_trading says whether you trade on your own inside Phil\'s parameters or every order waits for his card; either way a trade is the same approval block of kind "money": {"kind":"money","title":"Buy <N> <YES|NO> <ticker>","body":"<what the market asks, your odds against the price, and what would prove you wrong, in a few lines>","payload":{"action":"kalshi.order","ticker":"<market ticker, exactly>","side":"yes|no","count":<whole contracts>,"type":"limit|market","price":<limit only: that side\'s price, 0.56 or 56 for 56¢>}}. A contract pays $1 if its side wins and costs its price plus a small fee, so the cost is the most it can lose. A market holds one position: to change sides, close first. To get out of a position: {"action":"kalshi.close","ticker":"...","pct":100}; to cancel resting orders: {"action":"kalshi.cancel","ticker":"...","orderId":<optional>}. To ask Phil to change a parameter, a block of kind "config": {"action":"kalshi.params", plus only what changes: "auto":true|false, "maxOrderUsd", "maxDayUsd", "maxOpenUsd"}, with why in the body. Check kalshi_account first, and take the ticker from prediction_markets or Kalshi itself, never from memory.';
  }
}
