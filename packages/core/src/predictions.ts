import { z } from "zod";
import { defineTool, type ToolDef } from "./tools/index.js";
import type { Store } from "./store/types.js";

/**
 * Prediction markets for Cat: Polymarket and Kalshi, read-only. Both publish their markets openly, so prices, spreads,
 * volume and liquidity need no key. Phil's own Polymarket positions are read from his public wallet address (Settings ›
 * Polymarket), never a key: nothing here can place or cancel a bet. (Kalshi positions need a Kalshi API key; not here.)
 */
const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const usd = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n).toLocaleString("en-US")}`);
const cents = (p: number) => `${(p * 100).toFixed(p < 0.1 || p > 0.9 ? 1 : 0)}¢`;
// A plain date ("2026-12-09") is that calendar day; a time is shown in New York (a date read as UTC midnight would slip
// to the day before).
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "");
const parse = <T,>(s: unknown, d: T): T => { if (typeof s !== "string") return (s as T) ?? d; try { return JSON.parse(s) as T; } catch { return d; } };

async function getJson<T>(url: string, f: typeof fetch): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await f(url, { headers: { accept: "application/json" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
    return (await res.json()) as T;
  } finally { clearTimeout(t); }
}

// ---- Polymarket ------------------------------------------------------------------------------------------------------

type PolyMarket = { question?: string; slug?: string; outcomes?: string; outcomePrices?: string; volume24hr?: number; liquidity?: string | number; endDate?: string; bestBid?: number; bestAsk?: number; oneDayPriceChange?: number | null; events?: { slug?: string; title?: string }[] };
type PolyEvent = { title?: string; slug?: string; volume24hr?: number; markets?: PolyMarket[] };

function polyLine(m: PolyMarket): string {
  const outs = parse<string[]>(m.outcomes, []), prices = parse<string[]>(m.outcomePrices, []).map(num);
  const odds = outs.length === 2 && outs[0] === "Yes" ? `Yes ${cents(prices[0] ?? 0)}` : outs.map((o, i) => `${o} ${cents(prices[i] ?? 0)}`).slice(0, 4).join(", ");
  const spread = m.bestBid && m.bestAsk ? ` (bid ${cents(m.bestBid)} / ask ${cents(m.bestAsk)})` : "";
  const move = m.oneDayPriceChange ? ` · ${m.oneDayPriceChange > 0 ? "+" : ""}${(m.oneDayPriceChange * 100).toFixed(1)}¢ today` : "";
  return `${m.question} · ${odds}${spread}${move} · 24h volume ${usd(num(m.volume24hr))} · liquidity ${usd(num(m.liquidity))}${m.endDate ? ` · ends ${day(m.endDate)}` : ""}${m.events?.[0]?.slug ? ` · polymarket.com/event/${m.events[0].slug}` : ""}`;
}

export async function polymarketTop(n = 8, f: typeof fetch = fetch): Promise<string[]> {
  const ms = await getJson<PolyMarket[]>(`${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=${n}`, f);
  return ms.map(polyLine);
}
export async function polymarketSearch(q: string, n = 8, f: typeof fetch = fetch): Promise<string[]> {
  const r = await getJson<{ events?: PolyEvent[] }>(`${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=6&events_status=active`, f);
  const ms = (r.events ?? []).flatMap((e) => (e.markets ?? []).map((m) => ({ ...m, events: m.events ?? [{ slug: e.slug, title: e.title }] })));
  return ms.filter((m) => m.outcomePrices).sort((a, b) => num(b.volume24hr) - num(a.volume24hr)).slice(0, n).map(polyLine);
}

// ---- Kalshi ----------------------------------------------------------------------------------------------------------

type KMarket = { ticker: string; yes_sub_title?: string; last_price_dollars?: string; yes_bid_dollars?: string; yes_ask_dollars?: string; previous_price_dollars?: string; volume_24h_fp?: string; open_interest_fp?: string; close_time?: string };
type KEvent = { event_ticker: string; title?: string; category?: string; markets?: KMarket[] };

/** Open Kalshi events, a few pages of them. Combo markets (parlays, "KXMVE…") are left out: they're one-offs. */
async function kalshiMarkets(f: typeof fetch, pages = 3): Promise<{ m: KMarket; e: KEvent }[]> {
  const out: { m: KMarket; e: KEvent }[] = [];
  let cursor = "";
  for (let i = 0; i < pages; i++) {
    const r = await getJson<{ events?: KEvent[]; cursor?: string }>(`${KALSHI}/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, f);
    for (const e of r.events ?? []) for (const m of e.markets ?? []) if (!/^KXMVE/.test(m.ticker)) out.push({ m, e });
    if (!r.cursor) break;
    cursor = r.cursor;
  }
  return out;
}
function kalshiLine({ m, e }: { m: KMarket; e: KEvent }): string {
  const last = num(m.last_price_dollars), prev = num(m.previous_price_dollars), bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars);
  const move = prev && last !== prev ? ` · ${last > prev ? "+" : ""}${((last - prev) * 100).toFixed(1)}¢ since yesterday` : "";
  return `${e.title}${m.yes_sub_title ? ` — ${m.yes_sub_title}` : ""} · Yes ${cents(last)}${bid || ask ? ` (bid ${cents(bid)} / ask ${cents(ask)})` : ""}${move} · 24h volume ${usd(num(m.volume_24h_fp))} · open interest ${usd(num(m.open_interest_fp))}${m.close_time ? ` · closes ${day(m.close_time)}` : ""}${e.category ? ` · ${e.category}` : ""} · ${m.ticker}`;
}
/**
 * Kalshi's own site search (the one kalshi.com uses): events with their markets and prices, ranked by recent volume, and
 * a real topic search. It isn't Kalshi's documented API, so when it fails HQ falls back to the documented events list
 * (unsorted, a few pages: a rougher picture).
 */
type KSearch = { current_page?: { event_ticker?: string; event_title?: string; event_subtitle?: string; category?: string; recent_volume?: number; markets?: { ticker: string; yes_subtitle?: string; last_price_dollars?: string; yes_bid_dollars?: string; yes_ask_dollars?: string; previous_price_dollars?: string; volume?: number; close_ts?: string; result?: string }[] }[] };
async function kalshiFind(q: string, n: number, f: typeof fetch): Promise<string[]> {
  const r = await getJson<KSearch>(`https://api.elections.kalshi.com/v1/search/series?query=${encodeURIComponent(q)}&page_size=${q ? 12 : 40}`, f);
  const evs = (r.current_page ?? []).filter((e) => !/^KXMVE/.test(e.event_ticker ?? "") && (e.markets ?? []).some((m) => !m.result));
  if (!evs.length && !(r.current_page ?? []).length) return [];
  const ranked = q ? evs : [...evs].sort((a, b) => num(b.recent_volume) - num(a.recent_volume));
  return ranked.slice(0, n).map((e) => {
    const ms = (e.markets ?? []).filter((m) => !m.result).sort((a, b) => num(b.volume) - num(a.volume)).slice(0, 3);
    const close = ms[0]?.close_ts;
    const each = ms.map((m) => {
      const last = num(m.last_price_dollars), prev = num(m.previous_price_dollars), bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars);
      return `${m.yes_subtitle ? `${m.yes_subtitle} ` : ""}Yes ${cents(last)}${bid || ask ? ` (bid ${cents(bid)} / ask ${cents(ask)})` : ""}${prev && prev !== last ? ` ${last > prev ? "+" : ""}${((last - prev) * 100).toFixed(1)}¢` : ""}`;
    }).join("; ");
    return `${e.event_title}${e.event_subtitle ? ` (${e.event_subtitle})` : ""} · ${each} · recent volume ${Math.round(num(e.recent_volume)).toLocaleString("en-US")} contracts${close ? ` · closes ${day(close)}` : ""}${e.category ? ` · ${e.category}` : ""} · ${e.event_ticker}`;
  });
}
export async function kalshiTop(n = 8, f: typeof fetch = fetch): Promise<string[]> {
  try { const x = await kalshiFind("", n, f); if (x.length) return x; } catch { /* the documented list below */ }
  return (await kalshiMarkets(f)).sort((a, b) => num(b.m.volume_24h_fp) - num(a.m.volume_24h_fp)).slice(0, n).map(kalshiLine);
}
export async function kalshiSearch(q: string, n = 8, f: typeof fetch = fetch): Promise<string[]> {
  try { return await kalshiFind(q, n, f); } catch { /* the documented list below */ }
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const hit = (await kalshiMarkets(f, 3)).filter(({ m, e }) => { const t = `${e.title} ${m.yes_sub_title ?? ""} ${e.category ?? ""} ${m.ticker}`.toLowerCase(); return words.every((w) => t.includes(w)); });
  return hit.sort((a, b) => num(b.m.volume_24h_fp) - num(a.m.volume_24h_fp)).slice(0, n).map(kalshiLine);
}

/** Both venues in one answer: the busiest markets, or those matching a topic. One venue failing doesn't hide the other. */
export async function marketsText(query?: string, f: typeof fetch = fetch): Promise<string> {
  const q = query?.trim();
  const [poly, kal] = await Promise.all([
    (q ? polymarketSearch(q, 8, f) : polymarketTop(8, f)).catch((e: Error) => [`(Polymarket couldn't be read: ${e.message})`]),
    (q ? kalshiSearch(q, 8, f) : kalshiTop(8, f)).catch((e: Error) => [`(Kalshi couldn't be read: ${e.message})`]),
  ]);
  const block = (name: string, xs: string[]) => `${name}${q ? ` matching "${q}"` : ", busiest in the last 24h"}:\n${xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- nothing open"}`;
  return [`Prediction markets (prices are the market's odds: 62¢ = 62%).`, block("Polymarket", poly), block("Kalshi", kal)].join("\n\n");
}

// ---- Phil's Polymarket positions, by public address --------------------------------------------------------------------

export interface PolyAccount { address: string; label: string }
export const POLY_ACCOUNTS_KEY = "polymarket.accounts";
export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
export async function polyAccounts(store: Pick<Store, "settings">, env: NodeJS.ProcessEnv = process.env): Promise<PolyAccount[]> {
  const saved = await store.settings.get<PolyAccount[]>(POLY_ACCOUNTS_KEY, []);
  if (saved.length) return saved;
  return (env.POLYMARKET_ADDRESS ?? "").split(",").map((x, i) => { const [l, a] = x.includes("=") ? x.split("=") : [`Account ${i + 1}`, x]; return { label: l!.trim(), address: (a ?? "").trim() }; }).filter((x) => isEvmAddress(x.address));
}

type PolyPos = { title?: string; outcome?: string; current_size?: number; avg_price?: number; current_price?: number; current_value?: number; total_cost_usdc?: number; unrealized_pnl?: number; realized_pnl?: number; status?: string; redeemable?: boolean; archived?: boolean; end_date?: string; event_slug?: string };

export async function polyPositionsText(acct: PolyAccount, f: typeof fetch = fetch): Promise<string> {
  const r = await getJson<{ data?: PolyPos[] }>(`${DATA}/v2/positions?user=${encodeURIComponent(acct.address.trim())}&limit=100`, f);
  const all = (r.data ?? []).filter((p) => !p.archived && num(p.current_size) > 0);
  const open = all.filter((p) => !p.redeemable).sort((a, b) => num(b.current_value) - num(a.current_value));
  const won = all.filter((p) => p.redeemable && num(p.current_value) > 0);
  const value = open.reduce((s, p) => s + num(p.current_value), 0), pnl = open.reduce((s, p) => s + num(p.unrealized_pnl), 0);
  const head = `${acct.label} (${acct.address.slice(0, 6)}…${acct.address.slice(-4)}): ${open.length} open position${open.length === 1 ? "" : "s"} worth ${usd(value)}, unrealized ${pnl >= 0 ? "+" : "-"}${usd(Math.abs(pnl))}.`;
  const lines = open.slice(0, 20).map((p) => `- ${p.title} · ${p.outcome} · ${Number(num(p.current_size).toFixed(2))} shares @ ${cents(num(p.avg_price))} avg, now ${cents(num(p.current_price))} · worth ${usd(num(p.current_value))} (${num(p.unrealized_pnl) >= 0 ? "+" : "-"}${usd(Math.abs(num(p.unrealized_pnl)))})${p.end_date ? ` · ends ${day(p.end_date)}` : ""}`);
  if (open.length > 20) lines.push(`- …and ${open.length - 20} smaller positions`);
  if (won.length) lines.push(`Resolved and waiting to be claimed (${usd(won.reduce((s, p) => s + num(p.current_value), 0))}): ${won.slice(0, 8).map((p) => `${p.title} (${p.outcome}, ${usd(num(p.current_value))})`).join("; ")}.`);
  return [head, ...lines].join("\n");
}

export const PREDICTION_TOOLS: ToolDef[] = [
  defineTool({
    name: "prediction_markets",
    description: "Polymarket and Kalshi, read-only: each market's odds (price = probability), bid/ask, the day's move, 24h volume, liquidity or open interest, and when it ends. With no topic: the busiest markets on each. With a topic (a few words like 'fed rate', 'bitcoin 100k', 'election'): the matching markets on both.",
    schema: { topic: z.string().max(80).optional() },
    async handler({ topic }) { try { return await marketsText(topic); } catch (e) { return `Prediction markets: ${(e as Error).message}`; } },
  }),
  defineTool({
    name: "polymarket_positions",
    description: "Phil's own Polymarket positions, read-only from the public wallet address he set in Settings › Polymarket: each open position's side, shares, average price, current price, value and PnL, and winnings waiting to be claimed. Nothing can be bet through it.",
    schema: {},
    async handler(_a, ctx) {
      try {
        const all = await polyAccounts(ctx.store);
        if (!all.length) return "No Polymarket account set. Phil adds his Polymarket wallet's public address (0x…, shown on his Polymarket profile) in Settings › Polymarket; read-only, no key.";
        return (await Promise.all(all.slice(0, 5).map((a) => polyPositionsText(a).catch((e: Error) => `${a.label}: couldn't read it (${e.message})`)))).join("\n\n");
      } catch (e) { return `Polymarket: ${(e as Error).message}`; }
    },
  }),
];
