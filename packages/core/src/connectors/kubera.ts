import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store/types.js";
import { defineTool, type ToolDef } from "../tools/index.js";
import type { Executor } from "../jarvis/orchestrator.js";

/**
 * Kubera for Munger: Phil's net worth, assets and debts, read-only, from the Kubera Data API v3.
 * Each request is signed: x-signature = hex HMAC-SHA256(secret, apiKey + timestamp + METHOD + path + body), with
 * x-api-token and x-timestamp (Unix seconds). Responses are wrapped in { data, errorCode }.
 * Kubera allows about 30 calls a minute and 100 a day on Essential (1000 on Black), so portfolios are cached for
 * 20 minutes, and one snapshot a day is kept so Munger can say what changed.
 *   KUBERA_API_KEY, KUBERA_SECRET   a read-only key from Kubera Settings > API (restrict it to the server's IP)
 * Nothing here writes to Kubera.
 */
export interface KuberaOptions { apiKey: string; secret: string; fetch?: typeof fetch; now?: () => number; baseUrl?: string }

type Value = { amount?: number; currency?: string };
export interface KuberaItem { id?: string; name?: string; description?: string | null; value?: Value; cost?: Value | null; ticker?: string | null; quantity?: number | null; connection?: { provider?: string; last_updated?: string } | null; parent_account?: string | null }
export interface KuberaPortfolio { id: string; name: string; currency: string; net_worth?: Value; assets?: KuberaItem[]; debts?: KuberaItem[]; insurance?: KuberaItem[] }
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
    const j = (await res.json().catch(() => ({}))) as { data?: T; message?: string };
    if (res.status === 401) throw new Error(`Kubera refused the key${j.message ? ` (${j.message})` : ""}. Check KUBERA_API_KEY and KUBERA_SECRET, and that the key allows this server's IP.`);
    if (res.status === 429) throw new Error("Kubera's daily limit is reached; try again later.");
    if (!res.ok) throw new Error(`Kubera error ${res.status}${j.message ? `: ${j.message}` : ""}`);
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
      const p = await this.get<KuberaPortfolio>(`/api/v3/data/portfolio/${encodeURIComponent(pick.id)}`);
      this.cache.set(pick.id, { at: this.now(), p });
      await this.store.settings.set(STATUS_KEY, { ok: true, at: new Date(this.now()).toISOString() });
      await this.remember(p);
      return p;
    } catch (e) {
      await this.store.settings.set(STATUS_KEY, { ok: false, at: new Date(this.now()).toISOString(), error: (e as Error).message });
      throw e;
    }
  }

  private netWorth(p: KuberaPortfolio) { return p.net_worth?.amount ?? sum(p.assets) - sum(p.debts); }

  /** Keep one snapshot per day (the latest of that day), 400 days. */
  private async remember(p: KuberaPortfolio) {
    const day = easternDay(this.now());
    const hist = await this.store.settings.get<Snapshot[]>(HISTORY_KEY, []);
    const items: Record<string, number> = {};
    for (const it of [...(p.assets ?? []), ...(p.debts ?? []).map((d) => ({ ...d, value: { ...d.value, amount: -amt(d.value) } }))]) if (it.name) items[it.name] = amt(it.value);
    const first = !hist.some((h) => h.day === day);
    const next = [...hist.filter((h) => h.day !== day), { day, netWorth: this.netWorth(p), assets: sum(p.assets), debts: sum(p.debts), items }].sort((a, b) => a.day.localeCompare(b.day)).slice(-400);
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
      `${p.name}: net worth ${money(nw, cur)} (assets ${money(sum(p.assets), cur)}, debts ${money(sum(p.debts), cur)}).`,
      [delta(wk), delta(mo)].filter(Boolean).join("; ") || "No earlier snapshot yet; changes show from tomorrow.",
    ];
    if (wk) {
      const movers = Object.entries(hist[hist.length - 1]!.items).map(([k, v]) => [k, v - (wk.items[k] ?? 0)] as const).filter(([, d]) => Math.abs(d) >= 1).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
      if (movers.length) lines.push(`Biggest moves this week: ${movers.map(([k, d]) => `${k} ${d >= 0 ? "+" : ""}${money(d, cur)}`).join(", ")}.`);
    }
    const stale = [...(p.assets ?? []), ...(p.debts ?? [])].filter((i) => i.connection?.last_updated && this.now() - Date.parse(i.connection.last_updated) > 3 * 86_400_000).map((i) => i.name);
    if (stale.length) lines.push(`Not synced in 3+ days: ${stale.slice(0, 6).join(", ")}.`);
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
