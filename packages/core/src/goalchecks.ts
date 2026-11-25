import type { AutoCheck, BenchmarkCheck, CheckOp } from "./events.js";
import type { MetricPoint } from "./store/types.js";
import { VENTURES, type VentureId } from "./registry/ventures.js";

/**
 * Benchmarks that tick themselves (Phil, Nov 23: "auto checked off when completed and cross checked against data we
 * have access to, things like Kubera and Robinhood"). A benchmark can carry a rule against a figure HQ already
 * reads: Kubera's net worth or one Kubera account (Robinhood shows up there as an account), or a figure on a
 * venture's board. HQ reads the figure, ticks the benchmark when the rule holds, unticks it when it stops holding,
 * and shows the source, the figure and when it was read beside the tick. A read that failed or is stale proves
 * nothing: the benchmark keeps its state and the row says what went wrong. Benchmarks with no data source (income
 * that lands in an account HQ can't see, a list written down) stay with David and Phil.
 */

/** One day's Kubera reading, as the connector keeps it under settings "kubera.history". */
export interface KuberaDay { day: string; netWorth: number; assets: number; debts: number; items: Record<string, number> }
export interface KuberaReadStatus { ok: boolean; at: string; error?: string }

/** What a check reads from. Each piece is optional: a missing source is reported, never guessed. */
export interface CheckData {
  now?: Date;
  kubera?: { status?: KuberaReadStatus | null; history: KuberaDay[] };
  metrics?: (venture: string, key: string, limit?: number) => Promise<MetricPoint[]>;
}

/** A Kubera reading older than this proves nothing about today. */
export const KUBERA_FRESH_MS = 36 * 3_600_000;
/** A board figure older than this (with no `days` window) is treated as stale. */
export const METRIC_FRESH_DAYS = 7;

const OPS: CheckOp[] = [">=", "<="];
export const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const holds = (op: CheckOp, figure: number, value: number) => (op === ">=" ? figure >= value : figure <= value);
const sym = (op: CheckOp) => (op === ">=" ? "≥" : "≤");
const easternDay = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dayBefore = (day: string, n: number) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - n); return t.toISOString().slice(0, 10); };

/** A check from an agent's payload or the API, or nothing when it isn't one HQ can run. */
export function parseCheck(raw: unknown): BenchmarkCheck | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const op = OPS.find((o) => o === r.op);
  const value = Number(r.value);
  if (!op || !Number.isFinite(value)) return undefined;
  const days = r.days === undefined || r.days === null || r.days === "" ? undefined : Math.round(Number(r.days));
  const window = days !== undefined && Number.isFinite(days) && days >= 2 ? { days: Math.min(days, 400) } : {};
  if (r.kind === "kubera_networth") return { kind: "kubera_networth", op, value, ...window };
  if (r.kind === "kubera_item") { const name = String(r.name ?? "").trim().slice(0, 80); return name ? { kind: "kubera_item", name, op, value } : undefined; }
  if (r.kind === "metric") {
    const venture = String(r.venture ?? "").trim(), key = String(r.key ?? "").trim().slice(0, 60);
    return venture && venture !== "root" && Object.prototype.hasOwnProperty.call(VENTURES, venture) && key ? { kind: "metric", venture, key, op, value, ...window } : undefined;
  }
  return undefined;
}

/** The rule in a few words, for the goals screen and for David. */
export function describeCheck(c: BenchmarkCheck): string {
  const held = "days" in c && c.days ? ` for ${c.days} days` : "";
  if (c.kind === "kubera_networth") return `Kubera net worth ${sym(c.op)} ${money(c.value)}${held}`;
  if (c.kind === "kubera_item") return `Kubera "${c.name}" ${sym(c.op)} ${money(c.value)}`;
  return `${VENTURES[c.venture as VentureId]?.short ?? c.venture} board ${c.key} ${sym(c.op)} ${c.value.toLocaleString("en-US")}${held}`;
}

const fmtAt = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";

/**
 * Read the figure and judge the rule. Never throws: a source that can't be read comes back with `error` and no
 * `met`, so the caller leaves the benchmark as it was.
 */
export async function evaluateCheck(c: BenchmarkCheck, data: CheckData): Promise<AutoCheck> {
  const now = data.now ?? new Date();
  const at = now.toISOString();
  if (c.kind === "kubera_networth" || c.kind === "kubera_item") {
    const source = "Kubera";
    const k = data.kubera;
    if (!k || !k.history.length) return { at, source, error: "Kubera isn't connected or hasn't been read yet" };
    const last = k.history[k.history.length - 1]!;
    const readAt = k.status?.ok ? k.status.at : undefined;
    if (k.status && !k.status.ok) return { at, source, error: `Kubera's last read failed${k.status.error ? `: ${k.status.error.slice(0, 120)}` : ""} (${fmtAt(k.status.at)})` };
    if (!readAt || now.getTime() - Date.parse(readAt) > KUBERA_FRESH_MS) return { at, source, error: `Kubera's last good reading is from ${readAt ? fmtAt(readAt) : last.day}; too old to go on` };
    const read = `read ${fmtAt(readAt)}`;
    if (c.kind === "kubera_item") {
      const q = c.name.toLowerCase();
      const hit = Object.entries(last.items).find(([n]) => n.toLowerCase() === q) ?? Object.entries(last.items).find(([n]) => n.toLowerCase().includes(q));
      if (!hit) return { at, source, error: `no account called "${c.name}" in Kubera` };
      return { at, source: `Kubera · ${hit[0]}`, figure: `${money(hit[1])}, ${read}`, met: holds(c.op, hit[1], c.value) };
    }
    const nw = last.netWorth;
    if (!c.days) return { at, source: "Kubera net worth", figure: `${money(nw)}, ${read}`, met: holds(c.op, nw, c.value) };
    const since = dayBefore(easternDay(now.getTime()), c.days - 1);
    const window = k.history.filter((h) => h.day >= since);
    const covered = window.length >= c.days;
    const met = covered && window.every((h) => holds(c.op, h.netWorth, c.value));
    const low = Math.min(...window.map((h) => h.netWorth)), high = Math.max(...window.map((h) => h.netWorth));
    return { at, source: "Kubera net worth", figure: `${money(nw)} today; ${window.length} of ${c.days} days on record${window.length > 1 ? ` (${money(low)} to ${money(high)})` : ""}, ${read}`, met };
  }
  const source = `${VENTURES[c.venture as VentureId]?.short ?? c.venture} board · ${c.key}`;
  if (!data.metrics) return { at, source, error: "the board can't be read here" };
  const points = await data.metrics(c.venture, c.key, 400);
  if (!points.length) return { at, source, error: `nothing recorded on the ${VENTURES[c.venture as VentureId]?.short ?? c.venture} board under ${c.key} yet` };
  const last = points[points.length - 1]!;
  const read = `recorded ${fmtAt(last.at)}${last.source ? ` by ${last.source}` : ""}`;
  if (!c.days) {
    if (now.getTime() - Date.parse(last.at) > METRIC_FRESH_DAYS * 86_400_000) return { at, source, figure: `${last.value.toLocaleString("en-US")}, ${read}`, error: `the last figure is from ${fmtAt(last.at)}; older than ${METRIC_FRESH_DAYS} days` };
    return { at, source, figure: `${last.value.toLocaleString("en-US")}, ${read}`, met: holds(c.op, last.value, c.value) };
  }
  // A "held for N days" rule: the latest reading of each day in the window, every one of them meeting the rule.
  const since = dayBefore(easternDay(now.getTime()), c.days - 1);
  const byDay = new Map<string, MetricPoint>();
  for (const p of points) { const d = easternDay(Date.parse(p.at)); if (d >= since) byDay.set(d, p); }
  const days = [...byDay.values()];
  const met = days.length >= c.days && days.every((p) => holds(c.op, p.value, c.value));
  return { at, source, figure: `${last.value.toLocaleString("en-US")} latest; ${days.length} of ${c.days} days on record, ${read}`, met };
}

/** The same check, judged: did anything about the tick change? */
export function tickFor(current: boolean, r: AutoCheck): boolean {
  return r.met === undefined ? current : r.met;
}
