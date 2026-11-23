import { z } from "zod";
import { defineTool, type ToolDef } from "./tools/index.js";
import type { Store } from "./store/types.js";

/**
 * Hyperliquid's public market data for Pentoshi: funding, open interest, price and volume for every perp. No key and no
 * account; read-only. Phil's own account is read the same way, from the public address he sets in Settings › Hyperliquid
 * (hyperliquid_account): positions, orders, fills, balances. No key is ever held, so nothing can be traded.
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

// ---- Phil's own account, by its public address (read-only) ----------------------------------------------------------

/** A Hyperliquid account Phil follows: its public address (never a key) and a name. */
export interface HlAccount { address: string; label: string }
export const HL_ACCOUNTS_KEY = "hyperliquid.accounts";
export const isHlAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
/** The accounts Phil set in Settings, else HYPERLIQUID_ADDRESS ("0x…" or "Main=0x…,Sub=0x…"). */
export async function hlAccounts(store: Pick<Store, "settings">, env: NodeJS.ProcessEnv = process.env): Promise<HlAccount[]> {
  const saved = await store.settings.get<HlAccount[] | null>(HL_ACCOUNTS_KEY, null);
  // Once Phil has saved a list in Settings (even an empty one), it's the answer; the environment is only a first default.
  if (saved) return saved;
  // No read address but a trade address for the API wallet: that's his account.
  return (env.HYPERLIQUID_ADDRESS || (env.HYPERLIQUID_TRADE_ADDRESS ? `Main=${env.HYPERLIQUID_TRADE_ADDRESS}` : "")).split(",").map((x, i) => { const [l, a] = x.includes("=") ? x.split("=") : [`Account ${i + 1}`, x]; return { label: l!.trim(), address: (a ?? "").trim() }; }).filter((x) => isHlAddress(x.address));
}

type Position = { coin: string; szi: string; entryPx?: string | null; positionValue?: string; unrealizedPnl?: string; returnOnEquity?: string; liquidationPx?: string | null; marginUsed?: string; leverage?: { type?: string; value?: number }; cumFunding?: { sinceOpen?: string } };
type Clearing = { marginSummary?: { accountValue?: string; totalNtlPos?: string; totalMarginUsed?: string }; withdrawable?: string; assetPositions?: { position: Position }[] };
type Order = { coin: string; side: string; limitPx?: string; sz?: string; origSz?: string; reduceOnly?: boolean; orderType?: string; triggerPx?: string; isTrigger?: boolean; timestamp?: number };
type Fill = { coin: string; px: string; sz: string; side: string; time: number; dir?: string; closedPnl?: string; fee?: string };
type Spot = { balances?: { coin: string; total: string; hold?: string; entryNtl?: string }[] };

async function info<T>(body: Record<string, unknown>, f: typeof fetch): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await f(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) throw new Error(`Hyperliquid answered ${res.status}`);
    return (await res.json()) as T;
  } finally { clearTimeout(t); }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const px = (n: number) => (n < 1 ? n.toPrecision(4) : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const signed = (n: number) => `${n >= 0 ? "+" : "-"}${usd(Math.abs(n))}`;
const et = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Phil's open perp positions across his saved accounts: the coin, the side, and where it liquidates. For tools that follow his trades. */
export async function hlOpenPositions(store: Pick<Store, "settings">, f: typeof fetch = fetch): Promise<{ coin: string; long: boolean; value: number; mark: number; liq?: number }[]> {
  const out: { coin: string; long: boolean; value: number; mark: number; liq?: number }[] = [];
  for (const acct of (await hlAccounts(store)).slice(0, 5)) {
    const given = acct.address.trim();
    const role = await info<{ role?: string; data?: { user?: string } }>({ type: "userRole", user: given }, f).catch(() => ({}) as { role?: string; data?: { user?: string } });
    const user = role.role === "agent" && role.data?.user && isHlAddress(role.data.user) ? role.data.user : given;
    const st = await info<Clearing>({ type: "clearinghouseState", user }, f).catch(() => ({}) as Clearing);
    for (const { position: p } of st.assetPositions ?? []) {
      const size = num(p.szi), value = num(p.positionValue);
      if (!size) continue;
      out.push({ coin: p.coin.toUpperCase(), long: size > 0, value, mark: value / Math.abs(size), liq: num(p.liquidationPx) || undefined });
    }
  }
  return out;
}

/**
 * One account in words: what it's worth, every open position with its liquidation distance, open orders, the last
 * day's fills and spot balances. Five public reads; nothing here can trade.
 */
export async function accountText(acct: HlAccount, f: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const given = acct.address.trim();
  // An API wallet holds nothing (Phil saved one, Nov 20, and read $0): read the account it trades for instead.
  const role = await info<{ role?: string; data?: { user?: string } }>({ type: "userRole", user: given }, f).catch(() => ({}) as { role?: string; data?: { user?: string } });
  const owner = role.role === "agent" ? role.data?.user : undefined;
  const user = owner && isHlAddress(owner) ? owner : given;
  const via = user !== given ? `; ${short(given)}, the address in Settings, is the API wallet that trades for it` : "";
  const [perp, orders, fills, spot] = await Promise.all([
    info<Clearing>({ type: "clearinghouseState", user }, f),
    info<Order[]>({ type: "frontendOpenOrders", user }, f).catch(() => [] as Order[]),
    info<Fill[]>({ type: "userFills", user }, f).catch(() => [] as Fill[]),
    info<Spot>({ type: "spotClearinghouseState", user }, f).catch(() => ({}) as Spot),
  ]);
  const ms = perp.marginSummary ?? {};
  const equity = num(ms.accountValue), used = num(ms.totalMarginUsed), ntl = num(ms.totalNtlPos);
  const lines = [`${acct.label} (${short(user)}${via}): perps account value ${usd(equity)}, margin used ${usd(used)}${equity ? ` (${Math.round((used / equity) * 100)}% of it)` : ""}, withdrawable ${usd(num(perp.withdrawable))}, open positions ${usd(ntl)}${equity ? ` (${(ntl / equity).toFixed(1)}x the account)` : ""}.`];
  const pos = (perp.assetPositions ?? []).map((x) => x.position).filter((p) => num(p.szi) !== 0).sort((a, b) => num(b.positionValue) - num(a.positionValue));
  if (pos.length) {
    // Any close to liquidation first, then the largest; a long tail is counted, not listed.
    const near = (p: Position) => { const sz = num(p.szi), m = sz ? num(p.positionValue) / Math.abs(sz) : 0, l = num(p.liquidationPx); return l && m ? Math.abs(m - l) / m < 0.15 : false; };
    const ordered = [...pos.filter(near), ...pos.filter((p) => !near(p))];
    lines.push(`Positions (${pos.length}${pos.length > 25 ? ", the 25 that matter most" : ""}):`);
    for (const p of ordered.slice(0, 25)) {
      const size = num(p.szi), value = num(p.positionValue), mark = size ? value / Math.abs(size) : 0, liq = num(p.liquidationPx);
      const away = liq && mark ? (Math.abs(mark - liq) / mark) * 100 : undefined;
      lines.push(`- ${away !== undefined && away < 15 ? "⚠ CLOSE TO LIQUIDATION · " : ""}${p.coin} ${size > 0 ? "long" : "short"} ${Math.abs(size)} @ ${px(num(p.entryPx))} · mark ${px(mark)} · ${usd(value)} · uPnL ${signed(num(p.unrealizedPnl))}${p.returnOnEquity ? ` (${pct(num(p.returnOnEquity) * 100, 1)} on margin)` : ""} · ${p.leverage?.value ?? "?"}x ${p.leverage?.type ?? ""}`.trimEnd() + `${liq ? ` · liquidation ${px(liq)} (${away!.toFixed(1)}% away)` : " · no liquidation price"}${p.cumFunding?.sinceOpen ? ` · funding since open ${num(p.cumFunding.sinceOpen) > 0 ? "paid" : "received"} ${usd(Math.abs(num(p.cumFunding.sinceOpen)))}` : ""}`);
    }
    if (pos.length > 25) lines.push(`- …and ${pos.length - 25} smaller positions worth ${usd(ordered.slice(25).reduce((t, p) => t + num(p.positionValue), 0))} in all.`);
  } else lines.push("No open perp positions.");
  if (orders.length) lines.push(`Open orders (${orders.length}):\n${orders.slice(0, 15).map((o) => `- ${o.coin} ${o.side === "B" ? "buy" : "sell"} ${o.sz ?? o.origSz} ${o.isTrigger && o.triggerPx ? `trigger ${px(num(o.triggerPx))} ` : ""}@ ${px(num(o.limitPx))}${o.orderType ? ` · ${o.orderType}` : ""}${o.reduceOnly ? " · reduce-only" : ""}`).join("\n")}${orders.length > 15 ? `\n- …and ${orders.length - 15} more` : ""}`);
  const day = fills.filter((x) => now - x.time < 86_400_000).sort((a, b) => b.time - a.time);
  if (day.length) {
    const pnl = day.reduce((s2, x) => s2 + num(x.closedPnl), 0), fees = day.reduce((s2, x) => s2 + num(x.fee), 0);
    lines.push(`Fills in the last 24h (${day.length}; closed PnL ${signed(pnl)}, fees ${usd(fees)}):\n${day.slice(0, 10).map((x) => `- ${et(x.time)} ${x.coin} ${x.dir ?? (x.side === "B" ? "buy" : "sell")} ${x.sz} @ ${px(num(x.px))}${num(x.closedPnl) ? ` · closed ${signed(num(x.closedPnl))}` : ""}`).join("\n")}`);
  }
  const bal = (spot.balances ?? []).filter((b) => num(b.total) !== 0);
  if (bal.length) lines.push(`Spot: ${bal.map((b) => `${b.coin} ${Number(num(b.total).toFixed(4))}${num(b.entryNtl) ? ` (cost ${usd(num(b.entryNtl))})` : ""}`).join(", ")}.`);
  return lines.join("\n");
}

export const HYPERLIQUID_TOOLS: ToolDef[] = [
  defineTool({
    name: "hyperliquid_account",
    description: "Phil's own Hyperliquid account(s), read-only from the public address he set in Settings: account value, margin, every open position (size, entry, mark, PnL, leverage, liquidation price and how far away), open orders, the last 24h of fills, spot balances. Nothing can be traded through it (trading is hyperliquid_trading, by approval card). Optionally one account by its name.",
    schema: { account: z.string().max(60).optional().describe("the account's name in Settings, when Phil has more than one") },
    async handler({ account }, ctx) {
      try {
        const all = await hlAccounts(ctx.store);
        if (!all.length) return "No Hyperliquid account set. Phil adds his wallet's public address (0x…) in Settings › Hyperliquid; it's read-only, no key.";
        const pick = account ? all.filter((x) => x.label.toLowerCase().includes(account.toLowerCase()) || x.address.toLowerCase() === account.toLowerCase()) : all;
        if (!pick.length) return `No Hyperliquid account called "${account}"; Phil's are ${all.map((x) => x.label).join(", ")}.`;
        const out = await Promise.all(pick.slice(0, 5).map((x) => accountText(x).catch((e: Error) => `${x.label}: couldn't read it (${e.message})`)));
        return out.join("\n\n");
      } catch (e) { return `Hyperliquid: ${(e as Error).message}`; }
    },
  }),
  defineTool({
    name: "hyperliquid_perps",
    description: "Hyperliquid perps market data (public, read-only): funding (hourly and APR), open interest, price, 24h change and volume. With no coins: the biggest open interest, the most extreme funding both ways and the biggest moves. With coins: those markets.",
    schema: { coins: z.array(z.string().max(20)).max(20).optional().describe("tickers like BTC, ETH, SOL") },
    async handler({ coins }) { try { return perpsText(await hyperliquidPerps(), coins); } catch (e) { return `Hyperliquid: ${(e as Error).message}`; } },
  }),
];
