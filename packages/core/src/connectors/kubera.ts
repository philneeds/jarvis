import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store/types.js";
import { defineTool, type ToolDef } from "../tools/index.js";
import type { Executor } from "../jarvis/orchestrator.js";

/**
 * Kubera for Munger: Phil's net worth, assets and debts, read-only, from the Kubera Data API v3.
 * Each request is signed: x-signature = hex HMAC-SHA256(secret, apiKey + timestamp + METHOD + path + body), with
 * x-api-token and x-timestamp (Unix seconds). Responses are wrapped in { data, errorCode }.
 * Kubera allows 600 calls a minute and 5,000 a day on Essential (25,000 on Black); portfolios are cached for 20
 * minutes anyway, and one snapshot a day is kept so Munger can say what changed. A timestamp more than 5 minutes off
 * is refused, so the server's clock matters.
 *   KUBERA_API_KEY, KUBERA_SECRET   a read-only key from Kubera Settings > API (restrict it to the server's IP)
 * Nothing here writes to Kubera.
 */
export interface KuberaOptions { apiKey: string; secret: string; fetch?: typeof fetch; now?: () => number; baseUrl?: string }

type Value = { amount?: number; currency?: string };
export interface KuberaItem { id?: string; name?: string; description?: string | null; value?: Value; cost?: Value | null; ticker?: string | null; quantity?: number | null; connection?: { provider?: string; last_updated?: string } | null; parent_account?: string | null }
export interface KuberaPortfolio { id: string; name: string; currency: string; net_worth?: Value; assets?: KuberaItem[]; debts?: KuberaItem[]; insurance?: KuberaItem[] }
/**
 * Kubera's v3 portfolio, as it really comes back: "asset" / "debt" / "insurance" arrays (singular), the totals as plain
 * numbers (netWorth, assetTotal, debtTotal), the currency as "ticker", and connections with providerName, lastUpdated
 * and status. Turned into the shape the rest of this file reads; the older plural shape still passes through.
 */
type RawItem = KuberaItem & { sheetName?: string; sectionName?: string; hidden?: boolean; connection?: { provider?: string; last_updated?: string; providerName?: string; lastUpdated?: string | null; status?: string; statusReason?: string } | null };
type RawPortfolio = Partial<KuberaPortfolio> & { ticker?: string; asset?: RawItem[]; debt?: RawItem[]; netWorth?: number; assetTotal?: number; debtTotal?: number; investable?: number };
export function normalizePortfolio(raw: RawPortfolio, fallback: { id: string; name: string; currency?: string }): KuberaPortfolio & { assetTotal?: number; debtTotal?: number } {
  const currency = raw.currency || raw.ticker || fallback.currency || "USD";
  const item = (i: RawItem): KuberaItem => ({
    ...i,
    value: typeof i.value === "number" ? { amount: i.value, currency } : i.value,
    connection: i.connection ? { provider: i.connection.provider ?? i.connection.providerName, last_updated: i.connection.last_updated ?? i.connection.lastUpdated ?? undefined, ...(i.connection.status ? { status: i.connection.status } : {}), ...(i.connection.statusReason ? { statusReason: i.connection.statusReason } : {}) } : null,
  });
  const visible = (xs?: RawItem[]) => (xs ?? []).filter((i) => !i.hidden).map(item);
  const nw = typeof raw.netWorth === "number" ? raw.netWorth : raw.net_worth?.amount;
  return {
    id: raw.id ?? fallback.id, name: raw.name ?? fallback.name, currency,
    ...(typeof nw === "number" ? { net_worth: { amount: nw, currency } } : {}),
    assets: visible(raw.assets ?? raw.asset), debts: visible(raw.debts ?? raw.debt), insurance: visible(raw.insurance),
    ...(typeof raw.assetTotal === "number" ? { assetTotal: raw.assetTotal } : {}),
    ...(typeof raw.debtTotal === "number" ? { debtTotal: raw.debtTotal } : {}),
  };
}

interface Snapshot { day: string; netWorth: number; assets: number; debts: number; items: Record<string, number> }

const CACHE_MS = 20 * 60_000;
const HISTORY_KEY = "kubera.history";
const STATUS_KEY = "kubera.status";

const money = (n: number, cur = "USD") => `${n < 0 ? "-" : ""}${cur === "USD" ? "$" : ""}${Math.abs(Math.round(n)).toLocaleString("en-US")}${cur !== "USD" ? ` ${cur}` : ""}`;
const amt = (v?: Value | null) => (typeof v?.amount === "number" && Number.isFinite(v.amount) ? v.amount : 0);
const sum = (xs: KuberaItem[] = []) => xs.reduce((s, x) => s + amt(x.value), 0);
const easternDay = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export class KuberaConnector {
  readonly id = "kubera";
  private f: typeof fetch;
  private now: () => number;
  private cache = new Map<string, { at: number; p: KuberaPortfolio }>();
  private list?: { at: number; items: { id: string; name: string; currency: string }[] };
  /** Called once a day with the net worth, so the Money board fills in. */
  onDaily?: (netWorth: number, portfolio: KuberaPortfolio) => Promise<void>;

  constructor(private store: Store, private opts: KuberaOptions) {
    this.f = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  static fromEnv(store: Store): KuberaConnector | undefined {
    const { KUBERA_API_KEY, KUBERA_SECRET } = process.env;
    return KUBERA_API_KEY && KUBERA_SECRET ? new KuberaConnector(store, { apiKey: KUBERA_API_KEY.trim(), secret: KUBERA_SECRET.trim() }) : undefined;
  }

  /** The three auth headers for one request. Exposed for tests. */
  sign(method: string, path: string, body = "", ts = String(Math.floor(this.now() / 1000))): Record<string, string> {
    const signature = createHmac("sha256", this.opts.secret).update(`${this.opts.apiKey}${ts}${method}${path}${body}`).digest("hex");
    return { "x-api-token": this.opts.apiKey, "x-timestamp": ts, "x-signature": signature };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.f(`${this.opts.baseUrl ?? "https://api.kubera.com"}${path}`, { headers: { ...this.sign("GET", path), "content-type": "application/json" } });
    const raw = await res.text().catch(() => "");
    let j: { data?: T; message?: string; error?: string; errorMessage?: string; errorCode?: number } = {};
    try { j = raw ? JSON.parse(raw) : {}; } catch { /* not JSON: an HTML error page, say */ }
    const said = (j.message || j.error || j.errorMessage || (raw && !raw.trimStart().startsWith("{") && !raw.includes("<") ? raw : "")).toString().slice(0, 200);
    if (/timestamp/i.test(said)) throw new Error(`Kubera says the time is off (${said}): the server's clock is more than 5 minutes wrong. On the droplet: sudo timedatectl set-ntp true`);
    if (res.status === 401 || res.status === 403) throw new Error(`Kubera refused the key (${res.status}${said ? `: ${said}` : ""}). Either KUBERA_API_KEY / KUBERA_SECRET don't match the key in Kubera Settings > API (the secret is shown only once, when the key is made), or the key is IP-restricted to an address other than this server's.`);
    if (res.status === 429) throw new Error("Kubera's limit is reached; try again later.");
    if (!res.ok) throw new Error(`Kubera error ${res.status}${said ? `: ${said}` : ""}`);
    if (j.errorCode && j.errorCode !== 0) throw new Error(`Kubera error ${j.errorCode}${said ? `: ${said}` : ""}`);
    return (j.data ?? (j as unknown as T));
  }

  async portfolios() {
    if (this.list && this.now() - this.list.at < CACHE_MS) return this.list.items;
    const items = await this.get<{ id: string; name: string; currency: string }[]>("/api/v3/data/portfolio");
    this.list = { at: this.now(), items };
    return items;
  }

  /** One portfolio (the first, or one whose name matches), cached; records the day's snapshot. */
  async portfolio(name?: string): Promise<KuberaPortfolio> {
    const all = await this.portfolios();
    if (!all.length) throw new Error("Kubera has no portfolios on this account.");
    const pick = name ? all.find((p) => p.name.toLowerCase().includes(name.toLowerCase())) : all[0];
    if (!pick) throw new Error(`No Kubera portfolio called "${name}". There are: ${all.map((p) => p.name).join(", ")}.`);
    const c = this.cache.get(pick.id);
    if (c && this.now() - c.at < CACHE_MS) return c.p;
    try {
      const p = normalizePortfolio(await this.get<RawPortfolio>(`/api/v3/data/portfolio/${encodeURIComponent(pick.id)}`), pick);
      this.cache.set(pick.id, { at: this.now(), p });
      await this.store.settings.set(STATUS_KEY, { ok: true, at: new Date(this.now()).toISOString() });
      await this.remember(p);
      return p;
    } catch (e) {
      await this.store.settings.set(STATUS_KEY, { ok: false, at: new Date(this.now()).toISOString(), error: (e as Error).message });
      throw e;
    }
  }

  private netWorth(p: KuberaPortfolio) { return p.net_worth?.amount ?? this.assetsOf(p) - this.debtsOf(p); }
  private assetsOf(p: KuberaPortfolio & { assetTotal?: number }) { return p.assetTotal ?? sum(p.assets); }
  private debtsOf(p: KuberaPortfolio & { debtTotal?: number }) { return p.debtTotal ?? sum(p.debts); }

  /** Keep one snapshot per day (the latest of that day), 400 days. */
  private async remember(p: KuberaPortfolio) {
    // An empty read (nothing in it, net worth 0) isn't a day's net worth: keep it out of the history and the Money board.
    if (!p.assets?.length && !p.debts?.length && !this.netWorth(p)) return;
    const day = easternDay(this.now());
    const hist = (await this.store.settings.get<Snapshot[]>(HISTORY_KEY, [])).filter((h) => h.netWorth || Object.keys(h.items).length);
    const items: Record<string, number> = {};
    for (const it of [...(p.assets ?? []), ...(p.debts ?? []).map((d) => ({ ...d, value: { ...d.value, amount: -amt(d.value) } }))]) if (it.name) items[it.name] = amt(it.value);
    const first = !hist.some((h) => h.day === day);
    const next = [...hist.filter((h) => h.day !== day), { day, netWorth: this.netWorth(p), assets: this.assetsOf(p), debts: this.debtsOf(p), items }].sort((a, b) => a.day.localeCompare(b.day)).slice(-400);
    await this.store.settings.set(HISTORY_KEY, next);
    if (first) await this.onDaily?.(this.netWorth(p), p).catch(() => undefined);
  }

  async status() {
    const s = await this.store.settings.get<{ ok: boolean; at: string; error?: string } | null>(STATUS_KEY, null);
    const hist = await this.store.settings.get<Snapshot[]>(HISTORY_KEY, []);
    return { configured: true, lastFetch: s, days: hist.length, netWorth: hist.length ? hist[hist.length - 1]!.netWorth : undefined };
  }

  /** Net worth now, versus a week ago and a month ago where the snapshots reach, and the biggest movers. */
  async summary(name?: string): Promise<string> {
    const p = await this.portfolio(name);
    const cur = p.currency || "USD";
    const nw = this.netWorth(p);
    const hist = await this.store.settings.get<Snapshot[]>(HISTORY_KEY, []);
    const ago = (days: number) => { const d = easternDay(this.now() - days * 86_400_000); return [...hist].reverse().find((h) => h.day <= d); };
    const delta = (s?: Snapshot) => (s ? `${nw - s.netWorth >= 0 ? "+" : ""}${money(nw - s.netWorth, cur)} since ${s.day}` : undefined);
    const wk = ago(7), mo = ago(30);
    const lines = [
      `${p.name}: net worth ${money(nw, cur)} (assets ${money(this.assetsOf(p), cur)}, debts ${money(this.debtsOf(p), cur)}).`,
      [delta(wk), delta(mo)].filter(Boolean).join("; ") || "No earlier snapshot yet; changes show from tomorrow.",
    ];
    if (wk) {
      const movers = Object.entries(hist[hist.length - 1]!.items).map(([k, v]) => [k, v - (wk.items[k] ?? 0)] as const).filter(([, d]) => Math.abs(d) >= 1).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
      if (movers.length) lines.push(`Biggest moves this week: ${movers.map(([k, d]) => `${k} ${d >= 0 ? "+" : ""}${money(d, cur)}`).join(", ")}.`);
    }
    const stale = [...(p.assets ?? []), ...(p.debts ?? [])].filter((i) => i.connection?.last_updated && this.now() - Date.parse(i.connection.last_updated) > 3 * 86_400_000).map((i) => i.name);
    if (stale.length) lines.push(`Not synced in 3+ days: ${stale.slice(0, 6).join(", ")}.`);
    const broken = [...(p.assets ?? []), ...(p.debts ?? [])].filter((i) => /error/i.test((i.connection as { status?: string } | null)?.status ?? "")).map((i) => i.name);
    if (broken.length) lines.push(`Connection errors in Kubera: ${broken.slice(0, 6).join(", ")}.`);
    if (!p.assets?.length && !p.debts?.length && !nw) lines.push(`Kubera sent this portfolio back empty: no assets or debts. If "${p.name}" isn't the portfolio with your accounts, say which one (Kubera has: ${(await this.portfolios()).map((x) => x.name).join(", ")}).`);
    return lines.join("\n");
  }

  async itemsText(query?: string, name?: string): Promise<string> {
    const p = await this.portfolio(name);
    const cur = p.currency || "USD";
    const q = query?.toLowerCase();
    const fmt = (kind: string, xs: KuberaItem[] = []) => xs
      .filter((i) => !q || `${i.name} ${i.description ?? ""} ${i.ticker ?? ""} ${i.connection?.provider ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => amt(b.value) - amt(a.value))
      .map((i) => `${kind} · ${i.name}${i.ticker ? ` (${i.ticker}${i.quantity ? ` × ${i.quantity}` : ""})` : ""}: ${money(amt(i.value), i.value?.currency ?? cur)}${i.cost && amt(i.cost) ? `, cost ${money(amt(i.cost), cur)}` : ""}${i.connection?.provider ? ` · via ${i.connection.provider}${i.connection.last_updated ? `, synced ${i.connection.last_updated.slice(0, 10)}` : ""}` : ""}`);
    const rows = [...fmt("Asset", p.assets), ...fmt("Debt", p.debts)];
    return rows.length ? rows.slice(0, 80).join("\n") : q ? `Nothing in Kubera matches "${query}".` : "Kubera returned no assets or debts.";
  }

  /** Net worth over time from the daily snapshots, plus each account's change over the period, for spotting patterns. */
  async historyText(days = 90): Promise<string> {
    const hist = (await this.store.settings.get<Snapshot[]>(HISTORY_KEY, [])).filter((h) => h.day >= easternDay(this.now() - days * 86_400_000));
    if (hist.length < 2) return `Only ${hist.length} daily snapshot${hist.length === 1 ? "" : "s"} so far; the history fills in one day at a time once Kubera is connected.`;
    // Weekly points keep it short: the last snapshot of each ISO week, plus today.
    const weekly = hist.filter((h, i) => i === hist.length - 1 || new Date(`${hist[i + 1]!.day}T12:00:00Z`).getUTCDay() === 1);
    const first = hist[0]!, last = hist[hist.length - 1]!;
    const lines = [
      `Net worth from ${first.day} to ${last.day} (${hist.length} daily snapshots): ${money(first.netWorth)} → ${money(last.netWorth)} (${last.netWorth - first.netWorth >= 0 ? "+" : ""}${money(last.netWorth - first.netWorth)}).`,
      `Weekly: ${weekly.map((h) => `${h.day} ${money(h.netWorth)} (assets ${money(h.assets)}, debts ${money(h.debts)})`).join("; ")}.`,
    ];
    const moves = Object.keys({ ...first.items, ...last.items }).map((k) => [k, (last.items[k] ?? 0) - (first.items[k] ?? 0)] as const).filter(([, d]) => Math.abs(d) >= 1).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (moves.length) lines.push(`Change by account over the period: ${moves.slice(0, 15).map(([k, d]) => `${k} ${d >= 0 ? "+" : ""}${money(d)}`).join(", ")}.`);
    const daily = hist.slice(1).map((h, i) => ({ day: h.day, d: h.netWorth - hist[i]!.netWorth }));
    const big = [...daily].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5);
    lines.push(`Biggest single days: ${big.map((x) => `${x.day} ${x.d >= 0 ? "+" : ""}${money(x.d)}`).join(", ")}.`);
    return lines.join("\n");
  }

  /**
   * Phil's holdings in a few lines, for the money team's shared memory: every position with a ticker (shares, value,
   * cost, gain) grouped by account, then the other investment accounts with their balances. Stocks first; cash,
   * property and the rest are Munger's and stay out unless there are no positions at all.
   */
  async holdingsText(name?: string): Promise<string> {
    const p = await this.portfolio(name);
    const cur = p.currency || "USD";
    const items = (p.assets ?? []) as (KuberaItem & { sheetName?: string; sectionName?: string })[];
    const positions = items.filter((i) => i.ticker && amt(i.value));
    const pct = (a: number, b: number) => (b ? ` (${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%)` : "");
    const lines: string[] = [];
    const byAccount = new Map<string, typeof positions>();
    for (const i of positions) { const k = i.parent_account || i.connection?.provider || i.sectionName || i.sheetName || "Other"; byAccount.set(k, [...(byAccount.get(k) ?? []), i]); }
    for (const [acct, xs] of [...byAccount].sort((a, b) => sum(b[1]) - sum(a[1]))) {
      lines.push(`${acct} (${money(sum(xs), cur)}): ${xs.sort((a, b) => amt(b.value) - amt(a.value)).map((i) => `${i.ticker}${i.quantity ? ` ${+i.quantity.toFixed(4)} sh` : ""} ${money(amt(i.value), cur)}${i.cost && amt(i.cost) ? ` cost ${money(amt(i.cost), cur)}${pct(amt(i.value), amt(i.cost))}` : ""}`).join("; ")}`);
    }
    const accounts = items.filter((i) => !i.ticker && amt(i.value) && /invest|brokerage|stock|retire|401|ira|roth|crypto/i.test(`${i.sheetName ?? ""} ${i.sectionName ?? ""} ${i.name ?? ""}`));
    if (accounts.length) lines.push(`Investment accounts without a position list: ${accounts.map((i) => `${i.name} ${money(amt(i.value), cur)}`).join("; ")}`);
    const total = sum(positions) + sum(accounts);
    const head = `Phil's holdings from Kubera, ${new Date(this.now()).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET${total ? `: ${money(total, cur)} invested of ${money(this.netWorth(p), cur)} net worth` : ""}. Read-only; for the full detail use kubera_items, or robinhood_read where you have it.`;
    if (!lines.length) return `${head}\nKubera lists no stock positions or investment accounts (only ${items.length} other asset${items.length === 1 ? "" : "s"}).`;
    return [head, ...lines].join("\n").slice(0, 5800);
  }

  tools(): ToolDef[] {
    const portfolio = z.string().max(80).optional().describe("Kubera portfolio name, if Phil has more than one");
    return [
      defineTool({ name: "kubera_networth", description: "Phil's net worth from Kubera (read-only): total, assets, debts, change over the last week and month, the biggest movers, and accounts that stopped syncing.", schema: { portfolio }, handler: async (a) => { try { return await this.summary(a.portfolio); } catch (e) { return `Kubera: ${(e as Error).message}`; } } }),
      defineTool({ name: "kubera_history", description: "Phil's net worth over time from the daily Kubera snapshots (read-only): weekly points, each account's change over the period, and the biggest single days. For spotting patterns.", schema: { days: z.number().int().min(7).max(400).optional() }, handler: async (a) => { try { return await this.historyText(a.days ?? 90); } catch (e) { return `Kubera: ${(e as Error).message}`; } } }),
      defineTool({ name: "kubera_items", description: "Phil's assets and debts in Kubera (read-only), largest first, optionally filtered by a word (an account, a ticker, a bank).", schema: { query: z.string().max(80).optional(), portfolio }, handler: async (a) => { try { return await this.itemsText(a.query, a.portfolio); } catch (e) { return `Kubera: ${(e as Error).message}`; } } }),
    ];
  }

  /** Read-only: nothing to approve. */
  executors(): Record<string, Executor> { return {}; }

  static promptHint(): string {
    return "Kubera is connected, read-only: kubera_networth for the total and what changed, kubera_items for accounts and holdings, kubera_history for the trend over weeks and months. Quote amounts as Kubera reports them and say when an account hasn't synced. Nothing can be moved or changed through it.";
  }
}
