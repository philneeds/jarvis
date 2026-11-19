import { z } from "zod";
import { defineTool, type ToolDef } from "./tools/index.js";
import type { Store } from "./store/types.js";

/**
 * Lighter perps for Pentoshi, read-only. Market data is public: price, the day's move and volume, open interest, and
 * funding, with the same coin's funding on Binance, Bybit and Hyperliquid next to it (Lighter publishes all four). Phil's
 * own Lighter account is read from his wallet's public address (Settings › Lighter), never a key: nothing here trades.
 * Lighter's funding feed gives each venue's rate per 8 hours as a fraction (checked Nov 19 2026: its Hyperliquid BTC
 * figure was exactly 8x Hyperliquid's own hourly rate); Lighter itself pays funding hourly.
 */
const API = "https://mainnet.zklighter.elliot.ai/api/v1";

type Book = { symbol: string; market_id: number; market_type?: string; status?: string; last_trade_price?: number; daily_price_change?: number; daily_quote_token_volume?: number; open_interest?: number; open_interest_usd?: number };
type Rate = { market_id: number; exchange: string; symbol: string; rate: number };
export interface LighterRow { coin: string; price: number; change24h: number; volume24h: number; oiUsd: number; funding8h: number; venues: Record<string, number> }

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const usd = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString("en-US")}`);
const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const px = (n: number) => (n < 1 ? n.toPrecision(4) : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
/** An 8-hour funding fraction as Lighter's hourly %, and the yearly rate. */
const hourly = (r8: number) => (r8 / 8) * 100;
const apr = (r8: number) => r8 * 3 * 365 * 100;

async function get<T>(path: string, f: typeof fetch): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await f(`${API}${path}`, { headers: { accept: "application/json" }, signal: ctl.signal });
    const j = (await res.json().catch(() => ({}))) as T & { code?: number; message?: string };
    if (!res.ok || (j.code && j.code !== 200)) throw new Error(j.message ? `Lighter: ${j.message}` : `Lighter answered ${res.status}`);
    return j;
  } finally { clearTimeout(t); }
}

export async function lighterPerps(f: typeof fetch = fetch): Promise<LighterRow[]> {
  const [books, rates] = await Promise.all([
    get<{ order_book_details?: Book[] }>("/orderBookDetails", f),
    get<{ funding_rates?: Rate[] }>("/funding-rates", f).catch(() => ({ funding_rates: [] as Rate[] })),
  ]);
  const byMarket = new Map<number, Record<string, number>>();
  for (const r of rates.funding_rates ?? []) byMarket.set(r.market_id, { ...(byMarket.get(r.market_id) ?? {}), [r.exchange]: num(r.rate) });
  return (books.order_book_details ?? []).filter((b) => (b.market_type ?? "perp") === "perp" && (b.status ?? "active") === "active").map((b) => {
    const price = num(b.last_trade_price), venues = byMarket.get(b.market_id) ?? {};
    return { coin: b.symbol, price, change24h: num(b.daily_price_change), volume24h: num(b.daily_quote_token_volume), oiUsd: num(b.open_interest_usd) || num(b.open_interest) * price, funding8h: venues.lighter ?? 0, venues };
  });
}

export function lighterText(rows: LighterRow[], coins?: string[]): string {
  if (!rows.length) return "Lighter returned no markets.";
  const line = (r: LighterRow) => `${r.coin}: ${px(r.price)} (${pct(r.change24h, 1)} 24h) · funding ${pct(hourly(r.funding8h), 4)}/h (${pct(apr(r.funding8h), 0)} APR) · OI ${usd(r.oiUsd)} · 24h volume ${usd(r.volume24h)}`;
  if (coins?.length) {
    const want = coins.map((c) => c.toUpperCase());
    const hit = rows.filter((r) => want.includes(r.coin.toUpperCase()));
    const missing = want.filter((c) => !hit.some((r) => r.coin.toUpperCase() === c));
    // The same coin on the other venues, per 8 hours, so a funding gap between venues shows.
    const venues = (r: LighterRow) => { const o = Object.entries(r.venues).filter(([v]) => v !== "lighter"); return o.length ? `\n  funding per 8h: Lighter ${pct(r.funding8h * 100, 4)} · ${o.map(([v, x]) => `${v[0]!.toUpperCase()}${v.slice(1)} ${pct(x * 100, 4)}`).join(" · ")}` : ""; };
    return [...hit.map((r) => line(r) + venues(r)), missing.length ? `Not listed on Lighter: ${missing.join(", ")}.` : ""].filter(Boolean).join("\n");
  }
  const liquid = rows.filter((r) => r.oiUsd >= 1_000_000);
  const by = (k: (r: LighterRow) => number, n = 5) => [...liquid].sort((a, b) => k(b) - k(a)).slice(0, n);
  const gaps = liquid.map((r) => { const o = Object.entries(r.venues).filter(([v]) => v !== "lighter"); const far = o.sort((a, b) => Math.abs(b[1] - r.funding8h) - Math.abs(a[1] - r.funding8h))[0]; return { r, far, gap: far ? Math.abs(far[1] - r.funding8h) : 0 }; }).filter((x) => x.far && x.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, 5);
  return [
    `Lighter perps (${rows.length} markets; the lists below skip those under $1M open interest). Funding is paid hourly.`,
    `Biggest open interest:\n${by((r) => r.oiUsd).map(line).join("\n")}`,
    `Highest funding (longs paying):\n${by((r) => r.funding8h).map(line).join("\n")}`,
    `Most negative funding (shorts paying):\n${by((r) => -r.funding8h).map(line).join("\n")}`,
    `Biggest 24h moves:\n${by((r) => Math.abs(r.change24h)).map(line).join("\n")}`,
    gaps.length ? `Widest funding gaps against other venues (per 8h):\n${gaps.map(({ r, far }) => `${r.coin}: Lighter ${pct(r.funding8h * 100, 4)} vs ${far![0]} ${pct(far![1] * 100, 4)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

// ---- Phil's own account, by public address ----------------------------------------------------------------------------

export interface LighterAccount { address: string; label: string }
export const LIGHTER_ACCOUNTS_KEY = "lighter.accounts";
export async function lighterAccounts(store: Pick<Store, "settings">, env: NodeJS.ProcessEnv = process.env): Promise<LighterAccount[]> {
  const saved = await store.settings.get<LighterAccount[]>(LIGHTER_ACCOUNTS_KEY, []);
  if (saved.length) return saved;
  return (env.LIGHTER_ADDRESS ?? "").split(",").map((x, i) => { const [l, a] = x.includes("=") ? x.split("=") : [`Account ${i + 1}`, x]; return { label: l!.trim(), address: (a ?? "").trim() }; }).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x.address));
}

type Pos = { symbol: string; sign: number; position: string; avg_entry_price?: string; position_value?: string; unrealized_pnl?: string; realized_pnl?: string; liquidation_price?: string; initial_margin_fraction?: string; margin_mode?: number; total_funding_paid_out?: string; open_order_count?: number };
type Acct = { index?: number; account_index?: number; account_type?: number; collateral?: string; available_balance?: string; total_asset_value?: string; positions?: Pos[]; pending_order_count?: number; total_order_count?: number };

/** Every Lighter account under one address (the main one and its sub-accounts): value, positions, liquidation distance. */
export async function lighterAccountText(acct: LighterAccount, f: typeof fetch = fetch): Promise<string> {
  const r = await get<{ accounts?: Acct[] }>(`/account?by=l1_address&value=${encodeURIComponent(acct.address.trim())}`, f).catch((e: Error) => { if (/not found/i.test(e.message)) return { accounts: [] as Acct[] }; throw e; });
  const accts = r.accounts ?? [];
  const who = `${acct.label} (${acct.address.slice(0, 6)}…${acct.address.slice(-4)})`;
  if (!accts.length) return `${who}: no Lighter account at this address.`;
  const out: string[] = [];
  for (const a of accts.slice(0, 6)) {
    const pos = (a.positions ?? []).filter((p) => num(p.position) !== 0).sort((x, y) => num(y.position_value) - num(x.position_value));
    const total = num(a.total_asset_value) || num(a.collateral);
    const ntl = pos.reduce((s, p) => s + num(p.position_value), 0);
    out.push(`${who}${accts.length > 1 ? `, account ${a.index ?? a.account_index}${a.account_type ? " (sub-account)" : ""}` : ""}: worth ${usd(total)}, available ${usd(num(a.available_balance))}, open positions ${usd(ntl)}${total ? ` (${(ntl / total).toFixed(1)}x)` : ""}.`);
    const near = (p: Pos) => { const sz = num(p.position), m = sz ? num(p.position_value) / sz : 0, l = num(p.liquidation_price); return l > 0 && m > 0 ? Math.abs(m - l) / m < 0.15 : false; };
    for (const p of [...pos.filter(near), ...pos.filter((x) => !near(x))].slice(0, 25)) {
      const size = num(p.position), mark = size ? num(p.position_value) / size : 0, liq = num(p.liquidation_price);
      const away = liq > 0 && mark ? (Math.abs(mark - liq) / mark) * 100 : undefined;
      const lev = num(p.initial_margin_fraction) ? Math.round(100 / num(p.initial_margin_fraction)) : undefined;
      const funding = num(p.total_funding_paid_out);
      out.push(`- ${away !== undefined && away < 15 ? "⚠ CLOSE TO LIQUIDATION · " : ""}${p.symbol} ${p.sign < 0 ? "short" : "long"} ${size} @ ${px(num(p.avg_entry_price))} · mark ${px(mark)} · ${usd(num(p.position_value))} · uPnL ${num(p.unrealized_pnl) >= 0 ? "+" : "-"}${usd(Math.abs(num(p.unrealized_pnl)))}${lev ? ` · ${lev}x` : ""} ${p.margin_mode === 1 ? "isolated" : "cross"}${away !== undefined ? ` · liquidation ${px(liq)} (${away.toFixed(1)}% away)` : " · no liquidation price"}${funding ? ` · funding ${funding > 0 ? "paid" : "received"} ${usd(Math.abs(funding))}` : ""}${p.open_order_count ? ` · ${p.open_order_count} open order${p.open_order_count === 1 ? "" : "s"}` : ""}`);
    }
    if (pos.length > 25) out.push(`- …and ${pos.length - 25} smaller positions`);
    if (!pos.length) out.push("- no open positions");
  }
  return out.join("\n");
}

export const LIGHTER_TOOLS: ToolDef[] = [
  defineTool({
    name: "lighter_perps",
    description: "Lighter perps market data (public, read-only): price, 24h change and volume, open interest, and funding (hourly and APR). With no coins: the biggest open interest, the most extreme funding both ways, the biggest moves, and the widest funding gaps against Binance, Bybit and Hyperliquid. With coins: those markets, with each venue's funding side by side.",
    schema: { coins: z.array(z.string().max(20)).max(20).optional().describe("tickers like BTC, ETH, SOL") },
    async handler({ coins }) { try { return lighterText(await lighterPerps(), coins); } catch (e) { return `Lighter: ${(e as Error).message}`; } },
  }),
  defineTool({
    name: "lighter_account",
    description: "Phil's own Lighter account(s), read-only from the public address he set in Settings › Lighter: value, available balance, every open position (size, entry, mark, PnL, leverage, liquidation price and how far away), funding paid, and sub-accounts. Nothing can be traded through it.",
    schema: {},
    async handler(_a, ctx) {
      try {
        const all = await lighterAccounts(ctx.store);
        if (!all.length) return "No Lighter account set. Phil adds the public address of the wallet he uses on Lighter (0x…) in Settings › Lighter; read-only, no key.";
        return (await Promise.all(all.slice(0, 5).map((a) => lighterAccountText(a).catch((e: Error) => `${a.label}: couldn't read it (${e.message})`)))).join("\n\n");
      } catch (e) { return `Lighter: ${(e as Error).message}`; }
    },
  }),
];
