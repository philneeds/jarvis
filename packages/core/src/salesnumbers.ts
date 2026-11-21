import type { Store } from "./store/types.js";
import type { ReportRow, ReportTable } from "./reportpdf.js";

/**
 * Phil's sales numbers, worked out by HQ from LeadPerfection's Sales Efficiency by Sales Rep and written onto the deck by
 * HQ, not typed by an agent (Phil, Nov 21 2026: the slides didn't match the report; an agent had put the sheet's own
 * close % on them and other figures were off). His definitions:
 *   close to issue = sold ÷ net issued (Nov 21; it was sold ÷ issued before)
 *   demo rate      = demos ÷ net issued (the sheet's Sit / demo %)
 *   NSLI           = (net $ + 70% of pre-net $) ÷ issued (Nov 16: the sheet's own NSLI leaves pre-net out)
 *   cancel rate    = cancelled ÷ sold; credit declines aren't cancels
 *   pending        = pre-net, about 70% of which goes net: projected net = net $ + 70% of pre-net $
 * Every pull of the report (lp_report, team-wide) is kept by its dates, so a deck can name its period and the one it
 * is compared with.
 * The period (Phil, Nov 21 2026: "always from the start of the month to every Tuesday"): month to date, the 1st
 * through the day the deck is built; compared with the same days of the month before. deckPeriod() works the dates
 * out, so they aren't left to an agent.
 */
export interface SalesRow {
  rep: string;
  issued: number; netIssued: number; demos: number; sold: number; gross: number;
  cancels: number; declines: number; preCount: number; pre: number; net: number;
}
export interface SalesPull { start: string; end: string; market?: string; at: string; team?: SalesRow; reps: SalesRow[] }
export const SALES_PULLS_KEY = "sales.pulls";

const n = (s?: string) => { if (!s) return 0; const v = Number(s.replace(/[$,%\s]/g, "")); return Number.isFinite(v) ? v : 0; };
const rowOf = (r: ReportRow): SalesRow => {
  const c = r.cells;
  return {
    rep: r.total ? "Team" : r.name,
    issued: n(c.Iss?.main), netIssued: n(c["Net Iss/opp"]?.main), demos: n(c["Sit / demo"]?.main), sold: n(c["Close count"]?.main),
    gross: n(c["Close $"]?.main), cancels: n(c["Cancelled count"]?.main), declines: n(c["Credit Decline count"]?.main),
    preCount: n(c["Pre-net count"]?.main), pre: n(c["Pre-net $"]?.main), net: n(c["Net $"]?.main),
  };
};

/** The rows of a Sales Efficiency report, or nothing for any other report. */
export function salesRows(t: ReportTable): { team?: SalesRow; reps: SalesRow[] } | undefined {
  const has = (k: string) => t.rows.some((r) => k in r.cells);
  if (!/sales efficiency/i.test(t.title) || !has("Iss") || !has("Close count")) return undefined;
  const total = t.rows.find((r) => r.total);
  return { team: total ? rowOf(total) : undefined, reps: t.rows.filter((r) => !r.total).map(rowOf) };
}

/** Each metric HQ can put on a slide: how it's worked out and how it's written. */
type Kind = "pct" | "money" | "count";
const ratio = (a: number, b: number) => (b ? a / b : undefined);
export const METRICS: Record<string, { kind: Kind; of: (r: SalesRow, team?: SalesRow) => number | undefined; says: string }> = {
  issued: { kind: "count", of: (r) => r.issued, says: "issued appointments" },
  net_issued: { kind: "count", of: (r) => r.netIssued, says: "net issued" },
  demos: { kind: "count", of: (r) => r.demos, says: "demos" },
  sold: { kind: "count", of: (r) => r.sold, says: "sales" },
  close: { kind: "pct", of: (r) => ratio(r.sold, r.netIssued), says: "close to issue: sold ÷ net issued" },
  demo: { kind: "pct", of: (r) => ratio(r.demos, r.netIssued), says: "demo rate: demos ÷ net issued" },
  gross: { kind: "money", of: (r) => r.gross, says: "gross sold (before cancels and credit declines)" },
  avg_sale: { kind: "money", of: (r) => ratio(r.gross, r.sold), says: "average sale: gross ÷ sold" },
  nsli: { kind: "money", of: (r) => ratio(r.net + 0.7 * r.pre, r.issued), says: "NSLI: (net + 70% of pre-net) ÷ issued" },
  cancels: { kind: "count", of: (r) => r.cancels, says: "cancelled sales" },
  cancel_rate: { kind: "pct", of: (r) => ratio(r.cancels, r.sold), says: "cancel rate: cancelled ÷ sold" },
  declines: { kind: "count", of: (r) => r.declines, says: "credit declines" },
  pending: { kind: "count", of: (r) => r.preCount, says: "pending (pre-net) sales" },
  pending_value: { kind: "money", of: (r) => r.pre, says: "pending (pre-net) dollars" },
  net: { kind: "money", of: (r) => r.net, says: "net dollars" },
  projected: { kind: "money", of: (r) => r.net + 0.7 * r.pre, says: "projected net: net + 70% of pre-net" },
  // A rep's part of the team (Nov 21: the volume board's "% of Team" column).
  gross_share: { kind: "pct", of: (r, t) => (t ? ratio(r.gross, t.gross) : undefined), says: "a rep's share of the team's gross" },
  sold_share: { kind: "pct", of: (r, t) => (t ? ratio(r.sold, t.sold) : undefined), says: "a rep's share of the team's sales" },
};
/** A figure for a row, with the team it's a share of. */
const valueOf = (def: (typeof METRICS)[string], row: SalesRow, pull: SalesPull) => def.of(row, pull.team);

const fmt = (kind: Kind, v: number | undefined, decimals?: number) => {
  if (v === undefined || !Number.isFinite(v)) return "n/a";
  if (kind === "pct") return `${(v * 100).toFixed(decimals ?? 1)}%`;
  if (kind === "money") return `$${Math.round(v).toLocaleString("en-US")}`;
  return Math.round(v).toLocaleString("en-US");
};

const us = (y: number, m: number, d: number) => `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * The dates a deck covers: the 1st of the month through today (Eastern), and the same days of the month before to
 * compare with. Built on the 1st, there is nothing of the new month yet: it covers the whole month just ended,
 * compared with the whole month before that.
 */
export function deckPeriod(now: Date = new Date()): { start: string; end: string; priorStart: string; priorEnd: string } {
  const [y, m, d] = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-").map(Number) as [number, number, number];
  const back = (yy: number, mm: number) => (mm === 1 ? ([yy - 1, 12] as const) : ([yy, mm - 1] as const));
  if (d === 1) {
    const [py, pm] = back(y, m), [qy, qm] = back(py, pm);
    return { start: us(py, pm, 1), end: us(py, pm, daysIn(py, pm)), priorStart: us(qy, qm, 1), priorEnd: us(qy, qm, daysIn(qy, qm)) };
  }
  const [py, pm] = back(y, m);
  return { start: us(y, m, 1), end: us(y, m, d), priorStart: us(py, pm, 1), priorEnd: us(py, pm, Math.min(d, daysIn(py, pm))) };
}
/** The period in words for the agent, with the deckfill "numbers" to copy. */
export function deckPeriodText(now: Date = new Date()): string {
  const p = deckPeriod(now);
  return `The deck covers ${p.start} to ${p.end} (month to date: the 1st through today, Phil's rule), compared with ${p.priorStart} to ${p.priorEnd} (the same days of the month before). Run lp_report for both (Sales Efficiency by Sales Rep, all markets, no rep), then put this in the deckfill: "numbers":{"period":"${p.start}-${p.end}","prior":"${p.priorStart}-${p.priorEnd}"}. Never a single week unless Phil asks for one.`;
}

/** Keep a pull by its dates (and market), newest replacing an older pull of the same range. */
export async function saveSalesPull(store: Pick<Store, "settings">, pull: SalesPull): Promise<void> {
  const all = await store.settings.get<SalesPull[]>(SALES_PULLS_KEY, []);
  const same = (p: SalesPull) => p.start === pull.start && p.end === pull.end && (p.market ?? "") === (pull.market ?? "");
  await store.settings.set(SALES_PULLS_KEY, [...all.filter((p) => !same(p)), pull].slice(-30));
}

const day = (s: string) => { const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? Date.UTC(+m[3]!, +m[1]! - 1, +m[2]!) : Date.parse(s); };
const short = (s: string) => s.replace(/^(\d{1,2})\/(\d{1,2})\/\d{4}$/, (_m, a: string, b: string) => `${a.padStart(2, "0")}/${b.padStart(2, "0")}`);

/**
 * The two pulls a deck uses: "week" (the newest team-wide pull, or the one whose dates the deck names) and "prior"
 * (the pull that ends before it starts, nearest first).
 */
export async function pullsFor(store: Pick<Store, "settings">, want?: { week?: string; period?: string; prior?: string }): Promise<{ week?: SalesPull; prior?: SalesPull }> {
  const all = (await store.settings.get<SalesPull[]>(SALES_PULLS_KEY, [])).filter((p) => !p.market);
  const named = (r?: string) => { if (!r) return undefined; const [a, b] = r.split(/\s*(?:-|–|to)\s*/); return all.filter((p) => day(p.start) === day(a ?? "") && day(p.end) === day(b ?? "")).at(-1); };
  const week = named(want?.period ?? want?.week) ?? [...all].sort((a, b) => day(a.end) - day(b.end) || a.at.localeCompare(b.at)).at(-1);
  const prior = named(want?.prior) ?? (week ? all.filter((p) => day(p.end) < day(week.start)).sort((a, b) => day(b.end) - day(a.end))[0] : undefined);
  return { week, prior };
}

const findRep = (pull: SalesPull, name: string) => {
  const w = name.trim().toLowerCase();
  const reps = pull.reps.filter((r) => r.rep.toLowerCase() === w || r.rep.toLowerCase().split(/[,\s]+/).includes(w) || r.rep.toLowerCase().startsWith(`${w},`) || r.rep.toLowerCase().includes(w));
  return reps.length === 1 ? reps[0] : reps.find((r) => r.rep.toLowerCase() === w);
};

/**
 * Fill the {{...}} codes in a deck edit with the numbers:
 *   {{close}} {{demo}} {{gross}} ...           the team, the deck's period  {{prior.close}}   the comparison period
 *   {{rep:Marino.close}}                        one rep (last name is enough) {{prior.rep:Marino.close}}
 *   {{top.close.1.rep}} {{top.close.1}}         a leaderboard: the 1st rep by close, and their figure
 *   {{period}} {{prior.period}}                 the dates, "11/01–11/24" ({{week}} still reads the same)
 *   |0 after a percentage drops the decimal: {{demo|0}} is "73%".
 * Returns the text, or why a code can't be filled.
 */
export function fillNumbers(text: string, pulls: { week?: SalesPull; prior?: SalesPull }): { text: string; errors: string[] } {
  const errors: string[] = [];
  const out = text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, raw: string) => {
    const [body, opt] = raw.split("|");
    let code = body!.trim();
    const isPrior = code.startsWith("prior.");
    if (isPrior) code = code.slice(6);
    const pull = isPrior ? pulls.prior : pulls.week;
    if (!pull) { errors.push(`${whole}: there's no lp_report pull of Sales Efficiency for ${isPrior ? "the comparison period" : "the deck's period"}; run lp_report for those dates first`); return whole; }
    const decimals = opt !== undefined && /^\d$/.test(opt.trim()) ? Number(opt.trim()) : undefined;
    if (code === "week" || code === "period") return `${short(pull.start)}–${short(pull.end)}`;
    // How many reps ran appointments that week ("across 14 reps").
    if (code === "reps") return String(pull.reps.filter((r) => r.issued > 0).length);
    let row: SalesRow | undefined = pull.team, metric = code;
    let m = code.match(/^rep:(.+)\.([a-z_]+)$/);
    if (m) { row = findRep(pull, m[1]!); metric = m[2]!; if (!row) { errors.push(`${whole}: no rep "${m[1]}" in the ${short(pull.start)}–${short(pull.end)} report (reps: ${pull.reps.map((r) => r.rep).join("; ")})`); return whole; } }
    m = code.match(/^top\.([a-z_]+)\.(\d{1,2})(?:\.([a-z_]+))?$/);
    if (m) {
      const def = METRICS[m[1]!];
      if (!def) { errors.push(`${whole}: no figure called "${m[1]}" (there are: ${Object.keys(METRICS).join(", ")})`); return whole; }
      const ranked = pull.reps.filter((r) => r.issued > 0).map((r) => ({ r, v: valueOf(def, r, pull) })).filter((x) => x.v !== undefined).sort((a, b) => b.v! - a.v! || b.r.issued - a.r.issued);
      const hit = ranked[Number(m[2]) - 1];
      if (!hit) return "";
      if (m[3] === "rep") return hit.r.rep;
      if (m[3]) {
        const other = METRICS[m[3]];
        if (!other) { errors.push(`${whole}: no figure called "${m[3]}" (there are: ${Object.keys(METRICS).join(", ")})`); return whole; }
        return fmt(other.kind, valueOf(other, hit.r, pull), decimals);
      }
      return fmt(def.kind, hit.v, decimals);
    }
    const def = METRICS[metric];
    if (!def) { errors.push(`${whole}: no figure called "${metric}" (there are: ${Object.keys(METRICS).join(", ")})`); return whole; }
    if (!row) { errors.push(`${whole}: the report has no team total row`); return whole; }
    return fmt(def.kind, valueOf(def, row, pull), decimals);
  });
  return { text: out, errors };
}

/** The codes, for the agent: every figure with its definition, and the reps in the newest pull. */
export function numbersHint(): string {
  return `Numbers on a deck are written by HQ, never typed: put a code where the figure goes and HQ fills it from the last lp_report pull of Sales Efficiency (deck_period gives the dates to pull: month to date and its comparison). Codes: {{close}} {{demo}} … for the team over the deck's period; {{prior.close}} for the comparison period; {{rep:Marino.close}} for one rep (last name is enough); {{top.close.1.rep}} and {{top.close.1}} for a leaderboard's first name and figure (2, 3, … down the board), and {{top.gross.1.gross_share}} for another figure of that same rep; {{period}} and {{prior.period}} for the dates; {{reps}} for how many reps ran appointments; add |0 to a percentage for no decimal ({{demo|0}}). Figures: ${Object.entries(METRICS).map(([k, v]) => `${k} (${v.says})`).join("; ")}. Text around a code is yours ("Close rate {{close}}").`;
}
