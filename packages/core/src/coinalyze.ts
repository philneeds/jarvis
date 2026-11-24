import type { Store } from "./store/types.js";
import { hlOpenPositions } from "./hyperliquid.js";

/**
 * Liquidation data from Coinalyze's free API, for Pentoshi (Phil, Nov 23 2026: CoinGlass's API is paid; "i need a
 * free plan"). Read-only, as documented at api.coinalyze.net/v1/doc this month:
 *   COINALYZE_API_KEY   a free key from coinalyze.net (Account › API Key), sent as the api_key header
 *   - 40 calls a minute, and every market asked for counts as one, whatever request carries it
 *   - GET /liquidation-history?symbols=…&interval=15min&from=…&to=…&convert_to_usd=true gives, per market, the longs
 *     and shorts liquidated in each interval; GET /future-markets and /exchanges say which markets exist
 * A coin's number here is the sum over its main perpetual markets on the big venues (up to five a coin), not every
 * market there is, and the text says which venues. What the free API doesn't have is where liquidations would
 * cluster by price (the "liquidation map"): that is a paid product everywhere.
 */
const BASE = "https://api.coinalyze.net/v1";
const DAY_MS = 86_400_000;
/** The venues a coin is summed over, in order of preference; the first five that list it are used. */
const VENUES = ["binance", "bybit", "okx", "hyperliquid", "bitget", "gate", "kucoin", "bitmex"];

interface Market { symbol: string; exchange: string; base_asset: string; quote_asset: string; is_perpetual: boolean; margined?: string }
interface History { symbol: string; history?: { t: number; l?: number; s?: number }[] }
const lists = new Map<string, { at: number; v: unknown }>();
const answers = new Map<string, { at: number; v: unknown }>();
export const clearCoinalyzeCache = () => { lists.clear(); answers.clear(); };

const usd = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);
const px = (n: number) => (n < 1 ? n.toPrecision(4) : n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 }));

type Opts = { key?: string; fetch?: typeof fetch; hlFetch?: typeof fetch; now?: number };
async function get<T>(path: string, opts: Opts, keep: Map<string, { at: number; v: unknown }>, keepMs: number): Promise<T> {
  const key = opts.key ?? process.env.COINALYZE_API_KEY?.trim();
  if (!key) throw new Error("Coinalyze isn't connected (COINALYZE_API_KEY)");
  const now = opts.now ?? Date.now();
  const hit = keep.get(path);
  if (hit && now - hit.at < keepMs) return hit.v as T;
  let res: Response;
  try { res = await (opts.fetch ?? fetch)(`${BASE}${path}`, { headers: { api_key: key, accept: "application/json" }, signal: AbortSignal.timeout(15_000) }); }
  catch (e) { throw new Error(`Coinalyze didn't answer (${(e as Error).message.slice(0, 80)})`); }
  if (res.status === 429) { const wait = Number(res.headers.get("retry-after")); throw new Error(`Coinalyze's rate limit is hit${wait ? `; it says to wait ${Math.ceil(wait)} seconds` : "; try again in a minute"}`); }
  const j = (await res.json().catch(() => undefined)) as (T & { message?: string }) | undefined;
  if (res.status === 401) throw new Error(`Coinalyze refused the key${j?.message ? ` (${j.message})` : ""}; check COINALYZE_API_KEY`);
  if (!res.ok || j === undefined) throw new Error(`Coinalyze answered ${res.status}${j?.message ? `: ${j.message}` : ""}`);
  keep.set(path, { at: now, v: j });
  return j;
}

/** For Settings › Check: the key is asked afresh (a kept answer would hide a key that stopped working). One of the minute's 40 calls. */
export async function coinalyzeCheck(opts: Opts = {}): Promise<string> {
  const ex = await get<{ name: string }[]>("/exchanges", opts, new Map(), 0);
  if (!Array.isArray(ex) || !ex.length) throw new Error("Coinalyze answered, but with no venues; its API may have changed");
  const have = VENUES.filter((v) => ex.some((e) => (e.name ?? "").toLowerCase().includes(v)));
  return `Coinalyze accepted the key: ${ex.length} venues, ${have.length} of the ${VENUES.length} HQ sums liquidations over (${have.join(", ")}).`;
}

/** A coin's main perpetual markets on the big venues: stable-margined, quoted in a dollar, one per venue, five at most. */
export function marketsFor(coin: string, markets: Market[], exchanges: { name: string; code: string }[]): { symbol: string; venue: string }[] {
  const name = new Map(exchanges.map((e) => [e.code, e.name]));
  const mine = markets.filter((m) => m.is_perpetual && m.base_asset?.toUpperCase() === coin && /^(USDT|USD|USDC)$/i.test(m.quote_asset ?? ""));
  const out: { symbol: string; venue: string }[] = [];
  for (const v of VENUES) {
    const here = mine.filter((m) => (name.get(m.exchange) ?? "").toLowerCase().includes(v));
    // USDT-margined first (the deepest book), then USD, then USDC; a coin-margined contract only if there's nothing else.
    const pick = here.sort((a, b) => rank(a) - rank(b))[0];
    if (pick) out.push({ symbol: pick.symbol, venue: name.get(pick.exchange) ?? pick.exchange });
    if (out.length === 5) break;
  }
  return out;
}
const rank = (m: Market) => (m.margined === "COIN" ? 10 : 0) + ["USDT", "USD", "USDC"].indexOf((m.quote_asset ?? "").toUpperCase());

/** Longs and shorts liquidated over the last 1, 4 and 24 hours, summed over a coin's markets. */
export function windows(histories: History[], now: number): Record<"1h" | "4h" | "24h", { long: number; short: number }> {
  const out = { "1h": { long: 0, short: 0 }, "4h": { long: 0, short: 0 }, "24h": { long: 0, short: 0 } };
  for (const h of histories) for (const p of h.history ?? []) {
    const age = now - p.t * 1000;
    for (const [k, ms] of [["1h", 3_600_000], ["4h", 4 * 3_600_000], ["24h", DAY_MS]] as const) if (age <= ms) { out[k].long += p.l ?? 0; out[k].short += p.s ?? 0; }
  }
  return out;
}
function coinLine(coin: string, w: ReturnType<typeof windows>, venues: string[]): string {
  const part = (k: "1h" | "4h" | "24h") => {
    const { long, short } = w[k], total = long + short;
    if (!total) return `${k} nothing`;
    const side = long > short * 1.5 ? "mostly longs" : short > long * 1.5 ? "mostly shorts" : "both sides";
    return `${k} ${usd(total)} (longs ${usd(long)}, shorts ${usd(short)}; ${side})`;
  };
  return `${coin}: ${part("1h")} · ${part("4h")} · ${part("24h")} [${venues.join(", ")}]`;
}

/** Liquidations in words, coin by coin: Phil's open positions first (with how far his own liquidation is), then the rest. */
export async function coinalyzeLiquidationsText(store: Pick<Store, "settings">, coins?: string[], opts: Opts = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const [markets, exchanges] = await Promise.all([get<Market[]>("/future-markets", opts, lists, DAY_MS), get<{ name: string; code: string }[]>("/exchanges", opts, lists, DAY_MS)]);
  const held = await hlOpenPositions(store, opts.hlFetch ?? opts.fetch ?? fetch).catch(() => []);
  // Five coins at five markets each is 25 of the minute's 40 calls.
  const want = [...new Set([...held.map((p) => p.coin), ...(coins?.length ? coins.map((c) => c.trim().toUpperCase()).filter(Boolean) : ["BTC", "ETH", "SOL"])])].slice(0, 5);
  const picked = new Map(want.map((c) => [c, marketsFor(c, markets, exchanges)]));
  const symbols = [...picked.values()].flat().map((m) => m.symbol);
  const histories: History[] = [];
  // The end time moves in two-minute steps, so a second scan inside that asks for the same thing and is answered from what's kept.
  const to = Math.floor(now / 120_000) * 120 + 120, from = to - 86_400;
  // A request carries up to 20 markets. Fifteen-minute steps: fine enough for "the last hour", one request for all three windows.
  for (let i = 0; i < symbols.length; i += 20) histories.push(...(await get<History[]>(`/liquidation-history?symbols=${symbols.slice(i, i + 20).map(encodeURIComponent).join(",")}&interval=15min&from=${from}&to=${to}&convert_to_usd=true`, opts, answers, 120_000)));
  const lines = ["Liquidations over the last 1, 4 and 24 hours (Coinalyze; each coin summed over its main perps on the venues in brackets, not every market):"];
  for (const c of want) {
    const ms = picked.get(c) ?? [];
    const pos = held.filter((p) => p.coin === c);
    const mine = pos.map((p) => `Phil is ${p.long ? "long" : "short"} ${usd(p.value)}${p.liq ? `, liquidation at ${px(p.liq)} (${((Math.abs(p.mark - p.liq) / p.mark) * 100).toFixed(1)}% away)` : ""}`).join("; ");
    const line = ms.length ? coinLine(c, windows(histories.filter((h) => ms.some((m) => m.symbol === h.symbol)), now), ms.map((m) => m.venue)) : `${c}: Coinalyze lists no perp market for it on the venues HQ sums`;
    lines.push(`${line}${mine ? `\n  ${mine}.` : ""}`);
  }
  lines.push("The price levels where liquidations would cluster aren't in this (no free source has them): judge crowding from these totals with funding and open interest.");
  return lines.join("\n");
}
