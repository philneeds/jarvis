import { z } from "zod";
import { defineTool, type ToolDef } from "./tools/index.js";

/**
 * Hyperliquid's public market data for Pentoshi: funding, open interest, price and volume for every perp. No key and no
 * account; read-only. (Phil's own positions would need his wallet address; Pentoshi asks for it when it's useful.)
 */
type Ctx = { funding?: string; openInterest?: string; markPx?: string; prevDayPx?: string; dayNtlVlm?: string; premium?: string | null };
export interface PerpRow { coin: string; fundingHr: number; fundingApr: number; oiUsd: number; price: number; change24h: number; volume24h: number }

const URL = "https://api.hyperliquid.xyz/info";
const num = (v?: string | null) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const usd = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString("en-US")}`);
const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;

export async function hyperliquidPerps(f: typeof fetch = fetch): Promise<PerpRow[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await f(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }), signal: ctl.signal });
    if (!res.ok) throw new Error(`Hyperliquid answered ${res.status}`);
    const [meta, ctxs] = (await res.json()) as [{ universe: { name: string; isDelisted?: boolean }[] }, Ctx[]];
    return meta.universe.map((u, i) => ({ u, c: ctxs[i] ?? {} })).filter(({ u }) => !u.isDelisted).map(({ u, c }) => {
      const price = num(c.markPx), prev = num(c.prevDayPx), fundingHr = num(c.funding) * 100;
      return { coin: u.name, fundingHr, fundingApr: fundingHr * 24 * 365, oiUsd: num(c.openInterest) * price, price, change24h: prev ? ((price - prev) / prev) * 100 : 0, volume24h: num(c.dayNtlVlm) };
    });
  } finally { clearTimeout(t); }
}

/** The market at a glance, or a few coins in detail. Funding on Hyperliquid is paid hourly; APR is that times 8,760. */
export function perpsText(rows: PerpRow[], coins?: string[]): string {
  if (!rows.length) return "Hyperliquid returned no markets.";
  const line = (r: PerpRow) => `${r.coin}: ${r.price < 1 ? r.price.toPrecision(4) : r.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${pct(r.change24h, 1)} 24h) · funding ${pct(r.fundingHr, 4)}/h (${pct(r.fundingApr, 1)} APR) · OI ${usd(r.oiUsd)} · vol ${usd(r.volume24h)}`;
  if (coins?.length) {
    const want = coins.map((c) => c.toUpperCase());
    const hit = rows.filter((r) => want.includes(r.coin.toUpperCase()));
    const missing = want.filter((c) => !hit.some((r) => r.coin.toUpperCase() === c));
    return [...hit.map(line), missing.length ? `Not listed on Hyperliquid: ${missing.join(", ")}.` : ""].filter(Boolean).join("\n");
  }
  const liquid = rows.filter((r) => r.oiUsd >= 1_000_000);
  const by = (k: (r: PerpRow) => number, n = 5) => [...liquid].sort((a, b) => k(b) - k(a)).slice(0, n);
  return [
    `Hyperliquid perps (${rows.length} markets; the lists below skip those under $1M open interest).`,
    `Biggest open interest:\n${by((r) => r.oiUsd).map(line).join("\n")}`,
    `Highest funding (longs paying):\n${by((r) => r.fundingHr).map(line).join("\n")}`,
    `Most negative funding (shorts paying):\n${by((r) => -r.fundingHr).map(line).join("\n")}`,
    `Biggest 24h moves:\n${by((r) => Math.abs(r.change24h)).map(line).join("\n")}`,
  ].join("\n\n");
}

export const HYPERLIQUID_TOOLS: ToolDef[] = [
  defineTool({
    name: "hyperliquid_perps",
    description: "Hyperliquid perps market data (public, read-only): funding (hourly and APR), open interest, price, 24h change and volume. With no coins: the biggest open interest, the most extreme funding both ways and the biggest moves. With coins: those markets.",
    schema: { coins: z.array(z.string().max(20)).max(20).optional().describe("tickers like BTC, ETH, SOL") },
    async handler({ coins }) { try { return perpsText(await hyperliquidPerps(), coins); } catch (e) { return `Hyperliquid: ${(e as Error).message}`; } },
  }),
];
