import { z } from "zod";
import { defineTool, type ToolDef } from "./tools/index.js";
import type { Store } from "./store/types.js";
import { hlOpenPositions } from "./hyperliquid.js";
import { coinalyzeLiquidationsText } from "./coinalyze.js";

/**
 * Liquidation data from CoinGlass, for Pentoshi (Phil, Nov 23 2026: "add liquidation data for Pentoshi and his
 * trades"). Read-only market data from CoinGlass's v4 API (docs.coinglass.com, as documented this month):
 *   COINGLASS_API_KEY   the key from the CoinGlass user center; it comes with a paid API plan and is sent as the
 *                       CG-API-KEY header
 * What a plan allows decides what comes back:
 *   - every plan: what was liquidated over the last 1, 4, 12 and 24 hours, longs against shorts, for every coin
 *     summed across exchanges (/api/futures/liquidation/coin-list)
 *   - Professional: where liquidations would cluster by price (/api/futures/liquidation/aggregated-map). On a
 *     smaller plan that part says so once and the rest still comes back.
 * CoinGlass answers HTTP 200 with its own "code" for errors ("0" is success), so both are read. Answers are kept
 * for a minute: the smallest plan allows 30 requests a minute.
 */
const BASE = "https://open-api-v4.coinglass.com";
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; v: unknown }>();

/** The plan doesn't include this endpoint (or this interval): said plainly, never treated as "no data". */
export class PlanError extends Error {}

type CoinRow = { symbol: string } & Record<string, number | string | undefined>;
type MapData = { last_price?: number; data?: { liqMapV2?: Record<string, [number, number, number | null, string | null][]> }[] };

const usd = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);
const px = (n: number) => (n < 1 ? n.toPrecision(4) : n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 }));
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export async function coinglass<T>(path: string, opts: { key?: string; fetch?: typeof fetch; now?: number } = {}): Promise<T> {
  const key = opts.key ?? process.env.COINGLASS_API_KEY?.trim();
  if (!key) throw new Error("CoinGlass isn't connected yet (Phil adds COINGLASS_API_KEY on the server once he has a CoinGlass API plan). Work without it, and don't bring it up unless he asks about liquidations");
  const now = opts.now ?? Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.at < CACHE_MS) return hit.v as T;
  let res: Response;
  try { res = await (opts.fetch ?? fetch)(`${BASE}${path}`, { headers: { "CG-API-KEY": key, accept: "application/json" }, signal: AbortSignal.timeout(15_000) }); }
  catch (e) { throw new Error(`CoinGlass didn't answer (${(e as Error).message.slice(0, 80)})`); }
  const j = (await res.json().catch(() => ({}))) as { code?: string | number; msg?: string; data?: T };
  const code = String(j.code ?? res.status);
  if (res.ok && code === "0") { cache.set(path, { at: now, v: j.data }); return j.data as T; }
  const msg = j.msg ? `: ${j.msg}` : "";
  if (code === "429" || res.status === 429) throw new Error("CoinGlass's rate limit is hit; try again in a minute");
  if (/invalid api key|api key missing/i.test(j.msg ?? "")) throw new Error(`CoinGlass refused the key${msg}; check COINGLASS_API_KEY`);
  if (code === "401" || code === "403") throw new PlanError(`this CoinGlass plan doesn't include it${msg}`);
  throw new Error(`CoinGlass answered ${code}${msg}`);
}

/** One coin's liquidations over the four windows, longs against shorts. */
export function coinLine(r: CoinRow): string {
  const w = (h: string) => {
    const long = n(r[`long_liquidation_usd_${h}`]), short = n(r[`short_liquidation_usd_${h}`]);
    const total = n(r[`liquidation_usd_${h}`]) || long + short;
    if (!total) return `${h} nothing`;
    const side = long > short * 1.5 ? "mostly longs" : short > long * 1.5 ? "mostly shorts" : "both sides";
    return `${h} ${usd(total)} (longs ${usd(long)}, shorts ${usd(short)}; ${side})`;
  };
  return `${r.symbol}: ${["1h", "4h", "24h"].map(w).join(" · ")}`;
}

/**
 * Where liquidations would cluster around the price, from CoinGlass's model: the three heaviest levels above and
 * below, within 15% of the price. The numbers are the model's intensity, not dollars, so they're only ranked.
 */
export function clusters(map: MapData): { price?: number; above: number[]; below: number[] } {
  const by = new Map<number, number>();
  for (const m of map.data ?? []) for (const pts of Object.values(m.liqMapV2 ?? {})) for (const p of pts ?? []) { const level = n(p?.[0]), w = n(p?.[1]); if (level > 0 && w > 0) by.set(level, (by.get(level) ?? 0) + w); }
  const price = n(map.last_price) || undefined;
  if (!price || !by.size) return { price, above: [], below: [] };
  // Neighbouring levels are one cluster: bucket to about a third of a percent of the price.
  const step = price * 0.0035, buckets = new Map<number, number>();
  for (const [level, w] of by) { if (Math.abs(level - price) / price > 0.15) continue; const b = Math.round(level / step) * step; buckets.set(b, (buckets.get(b) ?? 0) + w); }
  const top = (side: (b: number) => boolean) => [...buckets].filter(([b]) => side(b)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([b]) => b).sort((a, b) => Math.abs(a - price) - Math.abs(b - price));
  return { price, above: top((b) => b > price * 1.001), below: top((b) => b < price * 0.999) };
}

/** Liquidations in words: the market's biggest in the last hour, then each coin asked for (Phil's open positions first). */
export async function liquidationsText(store: Pick<Store, "settings">, coins?: string[], opts: { key?: string; fetch?: typeof fetch; hlFetch?: typeof fetch; now?: number } = {}): Promise<string> {
  const rows = await coinglass<CoinRow[]>("/api/futures/liquidation/coin-list", opts);
  const by = new Map(rows.map((r) => [String(r.symbol).toUpperCase(), r]));
  const held = await hlOpenPositions(store, opts.hlFetch ?? opts.fetch ?? fetch).catch(() => []);
  const want = [...new Set([...held.map((p) => p.coin), ...(coins?.length ? coins.map((c) => c.trim().toUpperCase()).filter(Boolean) : ["BTC", "ETH", "SOL"])])].slice(0, 8);
  const lines: string[] = [];
  const all = rows.reduce((t, r) => ({ long: t.long + n(r.long_liquidation_usd_24h), short: t.short + n(r.short_liquidation_usd_24h), hour: t.hour + n(r.liquidation_usd_1h) }), { long: 0, short: 0, hour: 0 });
  lines.push(`Liquidations across exchanges (CoinGlass): ${usd(all.long + all.short)} in the last 24h (longs ${usd(all.long)}, shorts ${usd(all.short)}), ${usd(all.hour)} in the last hour.`);
  const hot = [...rows].sort((a, b) => n(b.liquidation_usd_1h) - n(a.liquidation_usd_1h)).slice(0, 5).filter((r) => n(r.liquidation_usd_1h) > 0);
  if (hot.length) lines.push(`Biggest in the last hour: ${hot.map((r) => `${r.symbol} ${usd(n(r.liquidation_usd_1h))} (${n(r.long_liquidation_usd_1h) >= n(r.short_liquidation_usd_1h) ? "longs" : "shorts"})`).join(", ")}.`);
  let planNote = "";
  for (const c of want) {
    const r = by.get(c);
    const pos = held.filter((p) => p.coin === c);
    const mine = pos.map((p) => `Phil is ${p.long ? "long" : "short"} ${usd(p.value)}${p.liq ? `, liquidation at ${px(p.liq)} (${((Math.abs(p.mark - p.liq) / p.mark) * 100).toFixed(1)}% away)` : ""}`).join("; ");
    lines.push(`${r ? coinLine(r) : `${c}: CoinGlass has no liquidation data for it`}${mine ? `\n  ${mine}.` : ""}`);
    // Where the next liquidations sit by price: for the coins he holds (and the first asked for), when the plan has it.
    if (planNote || !(pos.length || c === want[0])) continue;
    try {
      const k = clusters(await coinglass<MapData>(`/api/futures/liquidation/aggregated-map?symbol=${encodeURIComponent(c)}&range=1d`, opts));
      if (k.price && (k.above.length || k.below.length)) lines.push(`  Liquidation clusters near ${px(k.price)} (model; the heaviest near the price, nearest first): above at ${k.above.map(px).join(", ") || "none close"} (shorts get squeezed there); below at ${k.below.map(px).join(", ") || "none close"} (longs get flushed there).`);
    } catch (e) {
      if (e instanceof PlanError) planNote = "Price levels where liquidations cluster (the liquidation map) need CoinGlass's Professional plan; this key's plan gives the totals above only.";
      else lines.push(`  (The liquidation map for ${c} couldn't be read: ${(e as Error).message})`);
    }
  }
  if (planNote) lines.push(planNote);
  return lines.join("\n");
}

export const COINGLASS_TOOLS: ToolDef[] = [
  defineTool({
    name: "liquidations",
    description: "Liquidation data (read-only; Coinalyze's free API, or CoinGlass when Phil has that plan): what was liquidated over the last 1, 4 and 24 hours across the big venues, longs against shorts, for each coin; for the coins Phil holds on Hyperliquid, how far his own liquidation price is. With no coins: his open positions, then BTC, ETH and SOL.",
    schema: { coins: z.array(z.string().max(20)).max(8).optional().describe("tickers like BTC, ETH, SOL") },
    async handler({ coins }, ctx) {
      // The free source when its key is there (Phil, Nov 23: "i need a free plan"); CoinGlass if he ever takes that plan.
      try {
        if (process.env.COINALYZE_API_KEY?.trim()) return await coinalyzeLiquidationsText(ctx.store, coins);
        if (process.env.COINGLASS_API_KEY?.trim()) return await liquidationsText(ctx.store, coins);
        return "Liquidations: not connected yet (Phil adds a free Coinalyze key, COINALYZE_API_KEY, on the server). Work without it, and don't bring it up unless he asks about liquidations.";
      } catch (e) { return `Liquidations: ${(e as Error).message}`; }
    },
  }),
];
/** For tests: forget what was kept. */
export const clearCoinglassCache = () => cache.clear();
