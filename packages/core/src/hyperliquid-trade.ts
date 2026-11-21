import type { Store } from "./store/types.js";
import type { Approval } from "./events.js";
import type { Describer, Executor } from "./jarvis/orchestrator.js";
import { defineTool, type ToolDef } from "./tools/index.js";

/**
 * Trading on Hyperliquid, every order only after Phil approves its card (Phil, Nov 20 2026: "every trade waits").
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
 * Limits are optional and off until Phil sets them (settings "hyperliquid.limits": { maxTradeUsd, maxDayUsd }).
 */
const INFO = "https://api.hyperliquid.xyz/info";
const LIMITS_KEY = "hyperliquid.limits";
const SPENT_KEY = "hyperliquid.spent";

/** The part of Hyperliquid's exchange API HQ uses: nothing that moves money out. */
export interface HlExchange {
  order(p: { orders: { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Gtc" | "Ioc" | "Alo" } } }[]; grouping: "na" }): Promise<{ response: { data: { statuses: ({ resting: { oid: number } } | { filled: { totalSz: string; avgPx: string; oid: number } } | { error: string })[] } } }>;
  cancel(p: { cancels: { a: number; o: number }[] }): Promise<unknown>;
  updateLeverage(p: { asset: number; isCross: boolean; leverage: number }): Promise<unknown>;
}
export interface HlMarket { coin: string; asset: number; szDecimals: number; maxLeverage: number; mark: number }
export interface HlLimits { maxTradeUsd?: number; maxDayUsd?: number }

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
  return { coin, buy: side === "buy" || side === "long", size: size! > 0 ? size : undefined, usd: dollars! > 0 ? dollars : undefined, price, market: String(p.type ?? (price ? "limit" : "market")).toLowerCase() !== "limit", reduceOnly: p.reduceOnly === true, leverage, cross: p.cross !== false, slippagePct: Math.min(Math.max(num(p.slippagePct) || 2, 0.1), 10) };
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
  /** Phil's limits from Settings: a dollar cap per trade and per day; 0 or empty switches one off. */
  async setLimits(l: HlLimits): Promise<HlLimits> {
    const clean = (v: unknown) => { const n = Math.round(num(v)); return n > 0 ? n : undefined; };
    const next = { maxTradeUsd: clean(l.maxTradeUsd), maxDayUsd: clean(l.maxDayUsd) };
    await this.store.settings.set(LIMITS_KEY, next);
    return next;
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
    const size = formatSize(ask.size ?? ask.usd! / (ask.price ?? m.mark), m.szDecimals);
    // A market order is an immediate-or-cancel limit a little past the mark, so it can't fill at any price.
    const raw = ask.market ? m.mark * (ask.buy ? 1 + ask.slippagePct / 100 : 1 - ask.slippagePct / 100) : ask.price!;
    const price = formatPrice(raw, m.szDecimals);
    // A limit price goes out exactly as the card shows it, or not at all.
    if (!ask.market && Number(price) !== ask.price) throw new Error(`${m.coin} prices go in steps here: ${px(ask.price!)} would be sent as ${price}; put ${price} (or the next step) on the card`);
    const notional = num(size) * (ask.market ? m.mark : num(price));
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
    if (ask.leverage) await this.opts.exchange.updateLeverage({ asset: q.m.asset, isCross: ask.cross, leverage: ask.leverage });
    const r = await this.opts.exchange.order({ orders: [{ a: q.m.asset, b: ask.buy, p: q.price, s: q.size, r: ask.reduceOnly, t: { limit: { tif: ask.market ? "Ioc" : "Gtc" } } }], grouping: "na" });
    const st = r.response.data.statuses[0];
    if (!st) throw new Error("Hyperliquid sent no status back; check the account");
    if ("error" in st) throw new Error(`Hyperliquid refused it: ${st.error}`);
    if ("filled" in st) {
      if (!ask.reduceOnly) await this.tally(num(st.filled.totalSz) * num(st.filled.avgPx));
      return `Hyperliquid: ${ask.buy ? "bought" : "sold"} ${st.filled.totalSz} ${q.m.coin} at ${px(num(st.filled.avgPx))} (${usd(num(st.filled.totalSz) * num(st.filled.avgPx))})${num(st.filled.totalSz) < num(q.size) ? `, ${num(q.size) - num(st.filled.totalSz)} of the ${q.size} didn't fill within ${ask.slippagePct}% of the mark and was cancelled` : ""}${ask.reduceOnly ? ", reducing the position" : ""}. Order ${st.filled.oid}.`;
    }
    if (!ask.reduceOnly) await this.tally(q.notional);
    return `Hyperliquid: ${ask.buy ? "buy" : "sell"} order for ${q.size} ${q.m.coin} at ${px(num(q.price))} is resting on the book (order ${st.resting.oid}); cancel it with a hyperliquid.cancel card.`;
  }

  /** The one tool: whether trading is on, the limits, and how to propose a trade (Grok agents get it run up front). */
  tools(): ToolDef[] {
    return [defineTool({
      name: "hyperliquid_trading",
      description: "Whether HQ can trade on Phil's Hyperliquid account, the limits he set, and how to propose a trade. Every order waits for Phil's approval.",
      schema: {},
      handler: async () => {
        const s = await this.status();
        if (!s.trading) return `Hyperliquid trading is off: ${s.problem}.`;
        const l = s.limits;
        return `Hyperliquid trading is on for ${s.account} (through API wallet ${s.agent}; it can trade, not withdraw). Limits: ${l.maxTradeUsd ? `${usd(l.maxTradeUsd)} per trade` : "none per trade"}, ${l.maxDayUsd ? `${usd(l.maxDayUsd)} a day` : "none per day"}.\n${HyperliquidTrader.promptHint()}`;
      },
    })];
  }

  executors(): Record<string, Executor> {
    return {
      "hyperliquid.order": async (a) => this.placeOrder((a.payload ?? {}) as Record<string, unknown>, a),
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
      "hyperliquid.leverage": (p) => `Sets ${String(p.coin ?? "?").toUpperCase()} leverage to ${num(p.leverage)}x ${p.cross === false ? "isolated" : "cross"} on Hyperliquid. Higher leverage moves the liquidation price closer.`,
    };
  }

  static promptHint(): string {
    return 'Hyperliquid trading is connected, and every order waits for Phil\'s approval card (nothing auto-approves). Propose one with an approval block of kind "money": {"kind":"money","title":"<Long|Short> <COIN> <size or $>","body":"<the thesis, the invalidation (where you\'d be wrong) and the risk, in a few lines>","payload":{"action":"hyperliquid.order","coin":"BTC","side":"buy|sell","usd":250,"type":"market|limit","price":<limit only>,"leverage":<optional>,"cross":true,"reduceOnly":false}} (or "size" in coins instead of "usd"; the smallest order is $10 of size). To close: {"action":"hyperliquid.close","coin":"BTC","pct":100}; to cancel resting orders: {"action":"hyperliquid.cancel","coin":"BTC","oid":<optional>}; leverage alone: {"action":"hyperliquid.leverage","coin":"BTC","leverage":5,"cross":true}. Check hyperliquid_account first: never propose something that pushes a position near liquidation without saying so.';
  }
}
