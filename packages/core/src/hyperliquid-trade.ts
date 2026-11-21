import type { Store } from "./store/types.js";
import type { Approval } from "./events.js";
import type { Describer, Executor } from "./jarvis/orchestrator.js";
import { defineTool, type ToolDef } from "./tools/index.js";

/**
 * Trading on Hyperliquid. Two ways, Phil's choice in Settings › Hyperliquid:
 *   - every order waits for his card (Nov 20 2026: "every trade waits"; the default), or
 *   - Pentoshi trades on his own inside the parameters Phil set, and only a change to them waits for Phil
 *     (Nov 21: "pentoshi needs to be able to trade on his own, approvals should only be for parameter changes").
 *     Turning that on needs every cap set: per trade, per day, leverage, and a loss stop. An order outside them is a
 *     card for Phil (over the per-trade or daily cap it's refused outright); a close, a reduce-only order or a cancel
 *     always goes through, since it only takes risk off.
 *
 * HQ signs with an API wallet (Hyperliquid › More › API: an agent key Phil approves for his account). An API wallet can
 * place, cancel and size orders for the account, and that's all: Hyperliquid has withdrawals signed by the main wallet
 * only, and an agent's own transfers must go back to the same account ("Destination must match the source address").
 * HQ also wires in nothing but order, close, cancel and leverage: no transfer of any kind exists in this file.
 *   HYPERLIQUID_AGENT_KEY       the API wallet's private key (never the main wallet's: that is refused)
 *   HYPERLIQUID_TRADE_ADDRESS   optional: the account Phil expects it to trade for; HQ refuses to trade if Hyperliquid says
 *                               the key belongs to another one
 * Which account the key trades for is asked of Hyperliquid itself (userRole), never guessed: an API wallet answers
 * "agent" with its owner; a main wallet's own key answers "user" and is refused.
 * The parameters live in settings "hyperliquid.limits" (HlLimits). Phil sets them in Settings, or approves a
 * hyperliquid.params card that Pentoshi files; neither the per-agent rules nor anything else can change them.
 */
const INFO = "https://api.hyperliquid.xyz/info";
const LIMITS_KEY = "hyperliquid.limits";
const SPENT_KEY = "hyperliquid.spent";
/** Resting orders HQ placed, so a cancel on his own never touches one Phil placed by hand. */
const OURS_KEY = "hyperliquid.ourOrders";
/** How placing alone says the last check failed: HQ puts the card back for Phil (orchestrator, aloneChecks). */
export const NOT_PLACED = "not placed on his own: ";

/** The part of Hyperliquid's exchange API HQ uses: nothing that moves money out. */
export interface HlExchange {
  order(p: { orders: { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Gtc" | "Ioc" | "Alo" } } }[]; grouping: "na" }): Promise<{ response: { data: { statuses: ({ resting: { oid: number } } | { filled: { totalSz: string; avgPx: string; oid: number } } | { error: string })[] } } }>;
  cancel(p: { cancels: { a: number; o: number }[] }): Promise<unknown>;
  updateLeverage(p: { asset: number; isCross: boolean; leverage: number }): Promise<unknown>;
}
export interface HlMarket { coin: string; asset: number; szDecimals: number; maxLeverage: number; mark: number }
export interface HlLimits {
  /** Dollars of size per new order, and per day (ET). Over either, an order is refused. */
  maxTradeUsd?: number; maxDayUsd?: number;
  /** Pentoshi trades on his own inside the rest. */
  auto?: boolean;
  /** Highest leverage an order he places alone may use. */
  maxLeverage?: number;
  /** Most open position size, all coins together, after the order. Optional. */
  maxOpenUsd?: number;
  /** Down this much over the last 24 hours (Hyperliquid's own PnL, deposits aside): new orders wait for Phil. */
  maxDayLossUsd?: number;
  /** Only these coins alone; empty means any. */
  coins?: string[];
}
/** The agent who may trade on his own. */
export const AUTO_TRADER = "pentoshi";
/** What has to be set before Pentoshi can trade on his own. */
export function autoMissing(l: HlLimits): string[] {
  return [!l.maxTradeUsd && "a per-trade cap", !l.maxDayUsd && "a daily cap", !l.maxLeverage && "a leverage cap", !l.maxDayLossUsd && "a daily loss stop"].filter((x): x is string => !!x);
}
/** The parameters in one line, for the tool, the cards and Settings. */
export function limitsText(l: HlLimits): string {
  const caps = `${l.maxTradeUsd ? `${usd(l.maxTradeUsd)} a trade` : "no per-trade cap"}, ${l.maxDayUsd ? `${usd(l.maxDayUsd)} a day` : "no daily cap"}`;
  if (!l.auto) return `Every order waits for Phil's card. Caps: ${caps}.`;
  return `Pentoshi trades on his own: up to ${caps}, ${l.maxLeverage}x leverage at most${l.maxOpenUsd ? `, ${usd(l.maxOpenUsd)} open at most` : ""}, stopping when down ${usd(l.maxDayLossUsd ?? 0)} over 24 hours${l.coins?.length ? `, only ${l.coins.join(", ")}` : ", any coin"}.`;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const px = (n: number) => (n < 1 ? n.toPrecision(4) : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const day = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
/** How much of a position a close card means: 1 to 100 percent, whole numbers; anything else is the whole position. */
export const closePct = (v: unknown) => { const n = Math.round(num(v)); return n >= 1 && n <= 100 ? n : 100; };

/** What a card asks for, read loosely: buy/long, sell/short; size in coins or dollars; market unless a price is given. */
export interface OrderAsk { coin: string; buy: boolean; size?: number; usd?: number; price?: number; market: boolean; reduceOnly: boolean; leverage?: number; cross: boolean; slippagePct: number }
export function readOrder(p: Record<string, unknown>): OrderAsk {
  const side = String(p.side ?? "").toLowerCase();
  if (!["buy", "long", "sell", "short"].includes(side)) throw new Error('the card needs "side": buy (long) or sell (short)');
  const coin = String(p.coin ?? "").trim().toUpperCase();
  if (!coin) throw new Error('the card needs the "coin", like BTC');
  const size = p.size === undefined ? undefined : num(p.size), dollars = p.usd === undefined ? undefined : num(p.usd), price = p.price === undefined ? undefined : num(p.price);
  if (!(size! > 0) && !(dollars! > 0)) throw new Error('the card needs a "size" in coins or "usd", the dollar amount');
  if (price !== undefined && !(price > 0)) throw new Error("the limit price isn't a positive number");
  const leverage = p.leverage === undefined ? undefined : Math.round(num(p.leverage));
  if (leverage !== undefined && !(leverage >= 1)) throw new Error("leverage must be 1 or more");
  const market = String(p.type ?? (price ? "limit" : "market")).toLowerCase() !== "limit";
  const reduceOnly = p.reduceOnly === true;
  // A market order has no price of its own (one on the card would size it wrongly), and a reduce-only order never
  // changes leverage: a tiny "close" must not be able to put the rest of a position at 40x.
  return { coin, buy: side === "buy" || side === "long", size: size! > 0 ? size : undefined, usd: dollars! > 0 ? dollars : undefined, price: market ? undefined : price, market, reduceOnly, leverage: reduceOnly ? undefined : leverage, cross: p.cross !== false, slippagePct: Math.min(Math.max(num(p.slippagePct) || 2, 0.1), 10) };
}

/** Hyperliquid's smallest new order, in dollars of size. */
export const MIN_ORDER_USD = 10;

export class HyperliquidTrader {
  readonly id = "hyperliquid-trade";
  private meta?: { at: number; markets: Map<string, HlMarket> };
  private role?: { at: number; v: { role: string; owner?: string } };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: Store, private opts: { exchange: HlExchange; account: () => Promise<string | undefined>; agentAddress: string; fetch?: typeof fetch }) {}

  /** What Hyperliquid says the signing key is: an API wallet ("agent", with the account it trades for) or not. */
  private async whoAmI(): Promise<{ role: string; owner?: string }> {
    if (this.role && Date.now() - this.role.at < 5 * 60_000) return this.role.v;
    const r = await this.info<{ role?: string; data?: { user?: string } }>({ type: "userRole", user: this.opts.agentAddress });
    const v = { role: String(r.role ?? "missing"), owner: r.data?.user };
    this.role = { at: Date.now(), v };
    return v;
  }

  /** From the environment: an API wallet key, refused when it is the traded account's own key. */
  static async fromEnv(store: Store): Promise<HyperliquidTrader | undefined> {
    const key = process.env.HYPERLIQUID_AGENT_KEY?.trim();
    if (!key) return undefined;
    const pk = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.warn("[hyperliquid] HYPERLIQUID_AGENT_KEY isn't a private key; trading stays off"); return undefined; }
    const { privateKeyToAccount } = await import("viem/accounts");
    const { ExchangeClient, HttpTransport } = await import("@nktkas/hyperliquid");
    const wallet = privateKeyToAccount(pk);
    const exchange = new ExchangeClient({ transport: new HttpTransport(), wallet }) as unknown as HlExchange;
    const account = async () => process.env.HYPERLIQUID_TRADE_ADDRESS?.trim() || undefined;
    return new HyperliquidTrader(store, { exchange, account, agentAddress: wallet.address });
  }

  async status() {
    const limits = await this.limits();
    const base = { agent: this.opts.agentAddress, limits };
    let me: { role: string; owner?: string };
    try { me = await this.whoAmI(); } catch (e) { return { ...base, trading: false, account: undefined as string | undefined, problem: `couldn't ask Hyperliquid what this key is (${(e as Error).message})` }; }
    const expected = (await this.opts.account())?.toLowerCase();
    const problem =
      me.role === "user" || me.role === "vault" || me.role === "subAccount" ? "HYPERLIQUID_AGENT_KEY is a main wallet's own key (it could withdraw); use an API wallet's key (Hyperliquid › More › API)"
      : me.role !== "agent" || !me.owner ? "Hyperliquid doesn't know this key as an API wallet yet: approve it on Hyperliquid (More › API), or it expired"
      : expected && expected !== me.owner.toLowerCase() ? `this API wallet trades for ${me.owner}, not ${expected} (HYPERLIQUID_TRADE_ADDRESS); fix one of them`
      : undefined;
    return { ...base, trading: !problem, account: me.owner, problem };
  }

  async limits(): Promise<HlLimits> { return this.store.settings.get<HlLimits>(LIMITS_KEY, {}); }
  /**
   * The parameters, as Phil set them in Settings or approved on a card: 0 or empty switches a cap off. Trading on his
   * own needs every cap set; asking for it without them is refused and nothing changes.
   */
  async setLimits(l: HlLimits): Promise<HlLimits> {
    // "1,000" and "$500" are 1000 and 500; anything else that isn't a number is refused, not read as "no cap".
    // Rounded down, so a cap never comes out higher than asked.
    const clean = (v: unknown, what: string) => {
      if (v === undefined || v === null || v === "" || v === 0) return undefined;
      const n = Number(String(v).replace(/[$,\s]/g, "").replace(/x$/i, ""));
      if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a number, not "${String(v)}"`);
      const f = Math.floor(n);
      return f > 0 ? f : undefined;
    };
    if (l.auto !== undefined && typeof l.auto !== "boolean") throw new Error(`"auto" must be true or false, not "${String(l.auto)}"`);
    const coins = [...new Set((Array.isArray(l.coins) ? l.coins : typeof l.coins === "string" ? String(l.coins).split(/[\s,]+/) : []).map((c) => String(c).trim().toUpperCase()).filter((c) => /^[A-Z0-9]{1,12}$/.test(c)))];
    const next: HlLimits = { maxTradeUsd: clean(l.maxTradeUsd, "the per-trade cap"), maxDayUsd: clean(l.maxDayUsd, "the daily cap"), auto: l.auto === true, maxLeverage: clean(l.maxLeverage, "the leverage cap"), maxOpenUsd: clean(l.maxOpenUsd, "the open positions cap"), maxDayLossUsd: clean(l.maxDayLossUsd, "the loss stop"), coins };
    const missing = autoMissing(next);
    if (next.auto && missing.length) throw new Error(`Pentoshi can trade on his own only once every cap is set: add ${missing.join(", ")}`);
    await this.store.settings.set(LIMITS_KEY, next);
    return next;
  }

  /** Hyperliquid's own PnL for the account over the last 24 hours (deposits and withdrawals don't count). */
  private async dayPnl(account: string): Promise<number> {
    const r = await this.info<[string, { pnlHistory?: [number, string][] }][]>({ type: "portfolio", user: account });
    const h = (Array.isArray(r) ? r : []).find((x) => x[0] === "day")?.[1]?.pnlHistory;
    if (!h?.length) throw new Error("Hyperliquid gave no PnL for the last day");
    return num(h[h.length - 1]![1]) - num(h[0]![1]);
  }

  /** For HQ's approval flow: run this card now, or leave it for Phil and say why on it (nothing to say for non-trades). */
  async runsAlone(a: Pick<Approval, "agentId" | "payload">): Promise<{ ok: boolean; why?: string }> {
    let why: string | undefined;
    try { why = await this.autoRefusal(a); } catch (e) { why = `it couldn't be checked (${(e as Error).message})`; }
    if (!why) return { ok: true, why: "inside your Hyperliquid trading parameters" };
    return { ok: false, why: /^(not a trade|only Pentoshi|trading on his own is off)/.test(why) ? undefined : `${NOT_PLACED}${why}` };
  }

  /**
   * Whether a card may run without Phil: undefined when it may (Pentoshi's, trading on his own is on, and it is inside
   * every parameter), else why not. Closing, reduce-only orders and cancels only take risk off, so they always may.
   */
  async autoRefusal(a: Pick<Approval, "agentId" | "payload">): Promise<string | undefined> {
    const p = (a.payload ?? {}) as Record<string, unknown>;
    const action = String(p.action ?? "");
    if (!/^hyperliquid\.(order|close|cancel|leverage)$/.test(action)) return "not a trade";
    if (a.agentId !== AUTO_TRADER) return "only Pentoshi trades on his own";
    const l = await this.limits();
    if (!l.auto) return "trading on his own is off";
    const missing = autoMissing(l);
    if (missing.length) return `trading on his own needs ${missing.join(", ")}`;
    // Phil's pause (Settings › kill switch) stops everything placed alone, risk-off included: he said stop.
    const kill = await this.store.settings.get<{ all?: boolean; trading?: boolean; agents?: string[] }>("killSwitch", {});
    if (kill.all || kill.trading || kill.agents?.includes(AUTO_TRADER)) return "trading is paused";
    const s = await this.status();
    if (!s.trading) return s.problem ?? "trading isn't set up";
    if (action === "hyperliquid.close") return undefined;
    if (action === "hyperliquid.cancel") {
      // Alone, only orders HQ placed: never one Phil placed himself (a stop he set by hand).
      const coin = String(p.coin ?? "").toUpperCase();
      const ours = await this.store.settings.get<number[]>(OURS_KEY, []);
      const open = await this.info<{ coin: string; oid: number }[]>({ type: "openOrders", user: s.account });
      const hit = open.filter((o) => o.coin.toUpperCase() === coin && (p.oid === undefined || o.oid === num(p.oid)));
      const theirs = hit.filter((o) => !ours.includes(o.oid));
      return theirs.length ? `${theirs.length === 1 ? "order" : "orders"} ${theirs.map((o) => o.oid).join(", ")} on ${coin} weren't placed by HQ (yours, by hand?), so cancelling ${theirs.length === 1 ? "it" : "them"} is your call` : undefined;
    }
    const coinOk = (c: string) => !l.coins?.length || l.coins.includes(c.toUpperCase());
    if (action === "hyperliquid.leverage") {
      const lev = Math.round(num(p.leverage));
      if (!coinOk(String(p.coin ?? ""))) return `${String(p.coin ?? "").toUpperCase()} isn't one of the coins he trades alone (${l.coins!.join(", ")})`;
      return lev >= 1 && lev <= l.maxLeverage! ? undefined : `${lev}x is over your ${l.maxLeverage}x leverage cap`;
    }
    const ask = readOrder(p);
    if (ask.reduceOnly) return undefined;
    if (!coinOk(ask.coin)) return `${ask.coin} isn't one of the coins he trades alone (${(l.coins ?? []).join(", ")})`;
    if (ask.leverage === undefined) return `the order doesn't say its leverage (alone, up to ${l.maxLeverage}x)`;
    if (ask.leverage > l.maxLeverage!) return `${ask.leverage}x is over your ${l.maxLeverage}x leverage cap`;
    const q = await this.plan(ask);
    if (l.maxOpenUsd) {
      const [st, orders] = await Promise.all([
        this.info<{ marginSummary?: { totalNtlPos?: string } }>({ type: "clearinghouseState", user: s.account }),
        // Resting orders count too: four resting buys under the cap could all fill.
        this.info<{ sz?: string; limitPx?: string; reduceOnly?: boolean; isTrigger?: boolean }[]>({ type: "frontendOpenOrders", user: s.account }),
      ]);
      const resting = (Array.isArray(orders) ? orders : []).filter((o) => !o.reduceOnly).reduce((t, o) => t + num(o.sz) * num(o.limitPx), 0);
      const open = num(st.marginSummary?.totalNtlPos) + resting;
      if (open + q.notional > l.maxOpenUsd) return `it would take open positions${resting ? " and resting orders" : ""} to ${usd(open + q.notional)}, over your ${usd(l.maxOpenUsd)} cap`;
    }
    let pnl: number;
    try { pnl = await this.dayPnl(s.account!); } catch (e) { return `today's PnL couldn't be read (${(e as Error).message}), so the loss stop can't be checked`; }
    if (-pnl >= l.maxDayLossUsd!) return `the account is down ${usd(-pnl)} over the last 24 hours, at or past your ${usd(l.maxDayLossUsd!)} loss stop`;
    return undefined;
  }

  private async info<T>(body: unknown): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Hyperliquid answered ${res.status}`);
    return (await res.json()) as T;
  }
  async market(coin: string): Promise<HlMarket> {
    if (!this.meta || Date.now() - this.meta.at > 30_000) {
      const [meta, ctxs] = await this.info<[{ universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] }, { markPx?: string }[]]>({ type: "metaAndAssetCtxs" });
      const markets = new Map<string, HlMarket>();
      meta.universe.forEach((u, i) => { if (!u.isDelisted) markets.set(u.name.toUpperCase(), { coin: u.name, asset: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, mark: num(ctxs[i]?.markPx) }); });
      this.meta = { at: Date.now(), markets };
    }
    const m = this.meta.markets.get(coin.toUpperCase());
    if (!m) throw new Error(`${coin} isn't a Hyperliquid perp`);
    return m;
  }

  /** The order as it would go out: size in coins, the price sent, and what it's worth. */
  async plan(ask: OrderAsk, fresh = false) {
    const { formatPrice, formatSize } = await import("@nktkas/hyperliquid/utils");
    if (fresh) this.meta = undefined;
    const m = await this.market(ask.coin);
    if (!m.mark) throw new Error(`no mark price for ${m.coin} right now`);
    if (ask.leverage && ask.leverage > m.maxLeverage) throw new Error(`${m.coin} allows up to ${m.maxLeverage}x, not ${ask.leverage}x`);
    // The highest price each coin can really fill at: a buy limit never fills above its price, but a sell limited below
    // the mark crosses the book and fills near the mark. Sized and valued at that, so a far-off limit can't slip past
    // the caps (a $499 sell at a quarter of the mark used to send four times the size).
    const ref = ask.market || ask.price === undefined ? m.mark : ask.buy ? ask.price : Math.max(ask.price, m.mark);
    let size = formatSize(ask.size ?? ask.usd! / ref, m.szDecimals);
    // Rounding the size down could leave a $10 order at $9.48: one step up meets Hyperliquid's minimum.
    if (ask.size === undefined && !ask.reduceOnly && num(size) * ref < MIN_ORDER_USD && ask.usd! >= MIN_ORDER_USD) size = formatSize((Math.round(num(size) * 10 ** m.szDecimals) + 1) / 10 ** m.szDecimals, m.szDecimals);
    // A market order is an immediate-or-cancel limit a little past the mark, so it can't fill at any price.
    const raw = ask.market ? m.mark * (ask.buy ? 1 + ask.slippagePct / 100 : 1 - ask.slippagePct / 100) : ask.price!;
    const price = formatPrice(raw, m.szDecimals);
    // A limit price goes out exactly as the card shows it, or not at all.
    if (!ask.market && Number(price) !== ask.price) throw new Error(`${m.coin} prices go in steps here: ${px(ask.price!)} would be sent as ${price}; put ${price} (or the next step) on the card`);
    const notional = num(size) * Math.max(ask.market ? m.mark : num(price), ref);
    // Hyperliquid refuses a new order under $10 (Phil's "$1 test trade", Nov 20): say so before a card is made.
    if (!ask.reduceOnly && notional < MIN_ORDER_USD) throw new Error(`Hyperliquid's smallest order is ${usd(MIN_ORDER_USD)}; this one is $${notional.toFixed(2)}. Make it at least ${usd(MIN_ORDER_USD)} (with leverage, the margin can be less)`);
    return { m, size, price, notional };
  }

  /** Refused before Phil sees it: a coin that doesn't exist, too much leverage, or over a limit he set. */
  async preflight(a: Omit<Approval, "id" | "at" | "status">): Promise<string | undefined> {
    const p = (a.payload ?? {}) as Record<string, unknown>;
    if (p.action !== "hyperliquid.order") return undefined;
    try {
      const ask = readOrder(p);
      const q = await this.plan(ask);
      // Closing or shrinking a position is never blocked by the limits (they cap new risk, not getting out of it).
      if (ask.reduceOnly) return undefined;
      const l = await this.limits();
      if (l.maxTradeUsd && q.notional > l.maxTradeUsd) return `${usd(q.notional)} is over the ${usd(l.maxTradeUsd)} per-trade limit.`;
      const spent = await this.store.settings.get<{ day: string; usd: number }>(SPENT_KEY, { day: day(), usd: 0 });
      if (l.maxDayUsd && (spent.day === day() ? spent.usd : 0) + q.notional > l.maxDayUsd) return `that would take today to ${usd((spent.day === day() ? spent.usd : 0) + q.notional)}, over the ${usd(l.maxDayUsd)} daily limit.`;
      return undefined;
    } catch (e) { return `${(e as Error).message}`; }
  }

  private async tally(notional: number) {
    const s = await this.store.settings.get<{ day: string; usd: number }>(SPENT_KEY, { day: day(), usd: 0 });
    await this.store.settings.set(SPENT_KEY, { day: day(), usd: (s.day === day() ? s.usd : 0) + notional });
  }
  private async ready(): Promise<string> {
    const s = await this.status();
    if (!s.trading) throw new Error(s.problem ?? "trading isn't set up");
    return s.account!;
  }

  /** One order, as approved: checked against the limits again at the moment it runs. */
  private placeOrder(payload: Record<string, unknown>, a: Approval): Promise<string> {
    // One at a time, so two cards approved together can't both slip under the daily limit before either is counted.
    const run = this.queue.then(() => this.placeOrderNow(payload, a), () => this.placeOrderNow(payload, a));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async placeOrderNow(payload: Record<string, unknown>, a: Approval): Promise<string> {
    await this.ready();
    const ask = readOrder(payload);
    const q = await this.plan(ask, true);
    // Limits are checked again at the moment it runs: the day may have filled up since the card was made.
    const blocked = await this.preflight({ ...a, payload });
    if (blocked) throw new Error(blocked);
    // Placed on his own: checked once more now, in line behind any order before it (exposure and the loss stop move).
    if (/^auto:/.test(a.note ?? "") && !ask.reduceOnly) { const why = await this.autoRefusal({ ...a, payload }); if (why) throw new Error(`${NOT_PLACED}${why}`); }
    if (ask.leverage && !ask.reduceOnly) await this.opts.exchange.updateLeverage({ asset: q.m.asset, isCross: ask.cross, leverage: ask.leverage });
    const r = await this.opts.exchange.order({ orders: [{ a: q.m.asset, b: ask.buy, p: q.price, s: q.size, r: ask.reduceOnly, t: { limit: { tif: ask.market ? "Ioc" : "Gtc" } } }], grouping: "na" });
    const st = r.response.data.statuses[0];
    if (!st) throw new Error("Hyperliquid sent no status back; check the account");
    if ("error" in st) throw new Error(`Hyperliquid refused it: ${st.error}`);
    if ("filled" in st) {
      if (!ask.reduceOnly) await this.tally(num(st.filled.totalSz) * num(st.filled.avgPx));
      return `Hyperliquid: ${ask.buy ? "bought" : "sold"} ${st.filled.totalSz} ${q.m.coin} at ${px(num(st.filled.avgPx))} (${usd(num(st.filled.totalSz) * num(st.filled.avgPx))})${num(st.filled.totalSz) < num(q.size) ? `, ${num(q.size) - num(st.filled.totalSz)} of the ${q.size} didn't fill within ${ask.slippagePct}% of the mark and was cancelled` : ""}${ask.reduceOnly ? ", reducing the position" : ""}. Order ${st.filled.oid}.`;
    }
    if (!ask.reduceOnly) await this.tally(q.notional);
    const ours = await this.store.settings.get<number[]>(OURS_KEY, []);
    await this.store.settings.set(OURS_KEY, [...ours, st.resting.oid].slice(-200));
    return `Hyperliquid: ${ask.buy ? "buy" : "sell"} order for ${q.size} ${q.m.coin} at ${px(num(q.price))} is resting on the book (order ${st.resting.oid}); cancel it with a hyperliquid.cancel card.`;
  }

  /** The one tool: whether trading is on, the limits, and how to propose a trade (Grok agents get it run up front). */
  tools(): ToolDef[] {
    return [defineTool({
      name: "hyperliquid_trading",
      description: "Whether HQ can trade on Phil's Hyperliquid account, the parameters he set (whether Pentoshi trades on his own, the caps), and how to file a trade or ask for a parameter change.",
      schema: {},
      handler: async () => {
        const s = await this.status();
        if (!s.trading) return `Hyperliquid trading is off: ${s.problem}.`;
        const l = s.limits;
        const spent = await this.store.settings.get<{ day: string; usd: number }>(SPENT_KEY, { day: day(), usd: 0 });
        const own = l.auto && !autoMissing(l).length
          ? `You trade on your own. A trade block inside these parameters is placed the moment HQ reads it, and Phil is told; one outside them becomes a card for Phil (over the per-trade or daily cap it's refused). Every order you place alone must say its "leverage". Closes, reduce-only orders and cancels always go through. Traded today: ${usd(spent.day === day() ? spent.usd : 0)}${l.maxDayUsd ? ` of ${usd(l.maxDayUsd)}` : ""}.`
          : `Phil can let you trade on your own in Settings › Hyperliquid, or you can ask with a hyperliquid.params card.`;
        return `Hyperliquid trading is on for ${s.account} (through API wallet ${s.agent}; it can trade, not withdraw). ${limitsText(l)}\n${own}\n${HyperliquidTrader.promptHint()}`;
      },
    })];
  }

  executors(): Record<string, Executor> {
    return {
      "hyperliquid.order": async (a) => this.placeOrder((a.payload ?? {}) as Record<string, unknown>, a),
      // A change to the parameters: only ever on Phil's approval (rules.ts never lets a hyperliquid.* card run alone).
      "hyperliquid.params": async (a) => {
        const p = (a.payload ?? {}) as Record<string, unknown>;
        const cur = await this.limits();
        const pick = <K extends keyof HlLimits>(k: K) => (k in p ? (p[k] as HlLimits[K]) : cur[k]);
        const next = await this.setLimits({ maxTradeUsd: pick("maxTradeUsd"), maxDayUsd: pick("maxDayUsd"), auto: pick("auto"), maxLeverage: pick("maxLeverage"), maxOpenUsd: pick("maxOpenUsd"), maxDayLossUsd: pick("maxDayLossUsd"), coins: pick("coins") });
        return `Hyperliquid parameters now: ${limitsText(next)}`;
      },
      "hyperliquid.close": async (a) => {
        const account = await this.ready();
        const p = (a.payload ?? {}) as Record<string, unknown>;
        const coin = String(p.coin ?? "").toUpperCase();
        const pct = closePct(p.pct);
        const st = await this.info<{ assetPositions?: { position: { coin: string; szi: string } }[] }>({ type: "clearinghouseState", user: account });
        const pos = (st.assetPositions ?? []).map((x) => x.position).find((x) => x.coin.toUpperCase() === coin && num(x.szi) !== 0);
        if (!pos) throw new Error(`there's no open ${coin} position to close`);
        const long = num(pos.szi) > 0;
        const done = await this.placeOrder({ action: "hyperliquid.order", coin, side: long ? "sell" : "buy", size: (Math.abs(num(pos.szi)) * pct) / 100, reduceOnly: true, slippagePct: p.slippagePct }, a);
        return `${pct === 100 ? "Closed" : `Closed ${pct}% of`} the ${coin} ${long ? "long" : "short"}. ${done}`;
      },
      "hyperliquid.cancel": async (a) => {
        const account = await this.ready();
        const p = (a.payload ?? {}) as Record<string, unknown>;
        const coin = String(p.coin ?? "").toUpperCase();
        const m = await this.market(coin);
        const open = await this.info<{ coin: string; oid: number }[]>({ type: "openOrders", user: account });
        const mine = open.filter((o) => o.coin.toUpperCase() === coin && (p.oid === undefined || o.oid === num(p.oid)));
        if (!mine.length) throw new Error(p.oid !== undefined ? `no open ${coin} order ${String(p.oid)}` : `no open ${coin} orders`);
        await this.opts.exchange.cancel({ cancels: mine.map((o) => ({ a: m.asset, o: o.oid })) });
        return `Hyperliquid: cancelled ${mine.length} ${coin} order${mine.length === 1 ? "" : "s"} (${mine.map((o) => o.oid).join(", ")}).`;
      },
      "hyperliquid.leverage": async (a) => {
        await this.ready();
        const p = (a.payload ?? {}) as Record<string, unknown>;
        const m = await this.market(String(p.coin ?? ""));
        const lev = Math.round(num(p.leverage));
        if (!(lev >= 1) || lev > m.maxLeverage) throw new Error(`${m.coin} leverage must be 1 to ${m.maxLeverage}`);
        await this.opts.exchange.updateLeverage({ asset: m.asset, isCross: p.cross !== false, leverage: lev });
        return `Hyperliquid: ${m.coin} leverage set to ${lev}x ${p.cross === false ? "isolated" : "cross"}.`;
      },
    };
  }

  /** What Phil reads on the card: the order exactly as it will go out, and what it puts at risk. */
  describe(): Record<string, Describer> {
    const real = "Real money on your Hyperliquid account, the moment you approve.";
    return {
      "hyperliquid.order": (p) => {
        try {
          const a = readOrder(p);
          const what = a.size ? `${a.size} ${a.coin}` : `about ${usd(a.usd!)} of ${a.coin}`;
          return `${a.market ? "Market" : "Limit"} ${a.buy ? "BUY (long)" : "SELL (short)"} ${what}${a.market ? `, filling within ${a.slippagePct}% of the mark or not at all` : ` at ${px(a.price!)}, resting until filled or cancelled`}${a.reduceOnly ? ", reduce-only (it can only shrink a position)" : ""}${a.leverage ? `, at ${a.leverage}x ${a.cross ? "cross" : "isolated"}: margin about ${a.usd ? usd(a.usd / a.leverage) : "size ÷ leverage"}` : ""}. ${real}`;
        } catch (e) { return `This order can't be read: ${(e as Error).message}.`; }
      },
      "hyperliquid.close": (p) => `Closes ${closePct(p.pct) < 100 ? `${closePct(p.pct)}% of ` : ""}your ${String(p.coin ?? "?").toUpperCase()} position at market (reduce-only, within ${num(p.slippagePct) || 2}% of the mark). ${real}`,
      "hyperliquid.cancel": (p) => `Cancels ${p.oid !== undefined ? `order ${String(p.oid)}` : "every open order"} on ${String(p.coin ?? "?").toUpperCase()} on Hyperliquid.`,
      "hyperliquid.params": (p) => {
        const names: Record<string, string> = { auto: "Pentoshi trades on his own", maxTradeUsd: "per-trade cap ($)", maxDayUsd: "daily cap ($)", maxLeverage: "leverage cap (x)", maxOpenUsd: "open positions cap ($)", maxDayLossUsd: "24-hour loss stop ($)", coins: "coins he trades alone" };
        const parts = Object.keys(names).filter((k) => k in p).map((k) => `${names[k]}: ${Array.isArray(p[k]) ? (p[k] as unknown[]).join(", ") || "any" : p[k] === true ? "yes" : p[k] === false ? "no" : p[k] ? String(p[k]) : "none"}`);
        return `Changes your Hyperliquid trading parameters. ${parts.length ? parts.join("; ") : "Nothing named to change"}. Everything not named stays as it is.`;
      },
      "hyperliquid.leverage": (p) => `Sets ${String(p.coin ?? "?").toUpperCase()} leverage to ${num(p.leverage)}x ${p.cross === false ? "isolated" : "cross"} on Hyperliquid. Higher leverage moves the liquidation price closer.`,
    };
  }

  static promptHint(): string {
    return 'Hyperliquid trading is connected. hyperliquid_trading says whether you trade on your own inside Phil\'s parameters or every order waits for his card; either way a trade is the same approval block of kind "money": {"kind":"money","title":"<Long|Short> <COIN> <size or $>","body":"<the thesis, the invalidation (where you\'d be wrong) and the risk, in a few lines>","payload":{"action":"hyperliquid.order","coin":"BTC","side":"buy|sell","usd":250,"type":"market|limit","price":<limit only>,"leverage":<optional>,"cross":true,"reduceOnly":false}} (or "size" in coins instead of "usd"; the smallest order is $10 of size). To close: {"action":"hyperliquid.close","coin":"BTC","pct":100}; to cancel resting orders: {"action":"hyperliquid.cancel","coin":"BTC","oid":<optional>}; leverage alone: {"action":"hyperliquid.leverage","coin":"BTC","leverage":5,"cross":true}. To ask Phil to change a parameter, a block of kind "config": {"action":"hyperliquid.params", plus only what changes: "auto":true|false, "maxTradeUsd", "maxDayUsd", "maxLeverage", "maxOpenUsd", "maxDayLossUsd", "coins":["BTC","ETH"]}, with why in the body. Check hyperliquid_account first: never trade into something that pushes a position near liquidation, and say so if one is close.';
  }
}
