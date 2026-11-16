/**
 * Reading a LeadPerfection report PDF as a table. Plain text extraction drops empty cells, so the numbers after a blank
 * slide left into the wrong column (Nov 16: Stevon read Credit Decline as Backlog and Net Iss/opp as demos). Here every
 * piece of text keeps its position: the headings give the columns, and each number goes to the column it sits under.
 *
 * Built on the layout of LeadPerfection's report PDFs (Sales Efficiency by Sales Rep): a name column; single columns
 * on the left (Iss, Net Iss/opp, Sit / demo); groups that each have a %Cnt and a %Vol sub-column (Close, Pre-net,
 * On-Hold, Cancelled, Credit Decline, Backlog, Complete, Net); a last single column on the right (NSLI over NCP). Each
 * row is two lines: counts and dollars, then the percentages under them. Anything that doesn't fit that shape returns
 * nothing, and the caller falls back to the plain text.
 */
export interface Cell { main?: string; second?: string }
export interface ReportRow { name: string; total: boolean; cells: Record<string, Cell> }
export interface ReportTable { title: string; subtitle: string[]; columns: string[]; rows: ReportRow[] }

interface Item { s: string; x: number; y: number; w: number }
interface Column { name: string; from: number; to: number; kind: "single" | "cnt" | "vol" | "tail"; group?: string }

const isNum = (s: string) => /^-?\$?\d[\d,]*(\.\d+)?%?$/.test(s.trim());

/** Text pieces of one page with positions from the top-left, merged pieces ("36,080 100%") split by their share of the width. */
async function itemsOf(buf: Buffer): Promise<Item[][]> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const pages: Item[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const height = page.getViewport({ scale: 1 }).height;
    const tc = await page.getTextContent();
    const out: Item[] = [];
    for (const raw of tc.items as { str?: string; transform?: number[]; width?: number }[]) {
      const s = (raw.str ?? "").replace(/\s+/g, " ").trim();
      if (!s || !raw.transform) continue;
      const x = raw.transform[4]!, y = height - raw.transform[5]!, w = raw.width ?? s.length * 5;
      const parts = s.split(" ");
      if (parts.length > 1 && parts.every(isNum)) {
        const per = w / s.length;
        let at = 0;
        for (const part of parts) { out.push({ s: part, x: x + at * per, y, w: part.length * per }); at += part.length + 1; }
      } else out.push({ s, x, y, w });
    }
    pages.push(out);
  }
  return pages;
}

/** The columns, from a page's headings. Undefined when the page has no %Cnt / %Vol headings. */
function columnsOf(items: Item[]): { cols: Column[]; headerBottom: number } | undefined {
  const sub = items.filter((i) => /^%\s*(cnt|vol)$/i.test(i.s)).sort((a, b) => a.x - b.x);
  const cnts = sub.filter((i) => /cnt/i.test(i.s)), vols = sub.filter((i) => /vol/i.test(i.s));
  if (cnts.length < 2 || cnts.length !== vols.length) return undefined;
  const subY = sub[0]!.y, headerTop = subY - 30, headerBottom = subY + 4;
  const heads = items.filter((i) => i.y >= headerTop && i.y <= headerBottom && !/^%\s*(cnt|vol)$/i.test(i.s));
  const firstCnt = cnts[0]!.x, lastVolEnd = vols[vols.length - 1]!.x + vols[vols.length - 1]!.w;
  const cols: Column[] = [];
  // Left single columns: headings between the name column and the first group, clustered by where they sit.
  const left = heads.filter((h) => h.x > 40 && h.x + h.w < firstCnt - 2).sort((a, b) => a.x - b.x);
  const clusters: Item[][] = [];
  for (const h of left) {
    const c = clusters.find((cl) => cl.some((o) => h.x < o.x + o.w + 3 && o.x < h.x + h.w + 3));
    if (c) c.push(h); else clusters.push([h]);
  }
  clusters.sort((a, b) => Math.min(...a.map((i) => i.x)) - Math.min(...b.map((i) => i.x)));
  for (const cl of clusters) {
    const name = [...cl].sort((a, b) => a.y - b.y || a.x - b.x).map((i) => i.s).join(" ").replace(/\s*\/\s*/g, " / ").replace(/\s+\/\s+(?=\w+$)/, (m) => m).replace(/Iss \/ opp/i, "Iss/opp").trim();
    cols.push({ name, from: Math.min(...cl.map((i) => i.x)), to: Math.max(...cl.map((i) => i.x + i.w)), kind: "single" });
  }
  // Groups: each %Cnt and the %Vol after it, named by the heading above them.
  for (let g = 0; g < cnts.length; g++) {
    const from = cnts[g]!.x, mid = vols[g]!.x, to = g + 1 < cnts.length ? cnts[g + 1]!.x : lastVolEnd + 12;
    const label = heads.filter((h) => h.y < subY - 2 && h.x + h.w / 2 >= from - 4 && h.x + h.w / 2 < to).map((h) => h.s).join(" ").trim() || `Group ${g + 1}`;
    cols.push({ name: label, group: label, from, to: mid, kind: "cnt" }, { name: label, group: label, from: mid, to, kind: "vol" });
  }
  // The column on the far right (NSLI over NCP).
  const tail = heads.filter((h) => h.x >= lastVolEnd + 4).sort((a, b) => a.y - b.y);
  if (tail.length) cols.push({ name: tail.map((t) => t.s).join(" / "), from: lastVolEnd + 12, to: Infinity, kind: "tail" });
  return { cols, headerBottom };
}

/** Which column a number belongs to: single columns by its middle, the rest by its right edge (they're right-aligned). */
function columnFor(cols: Column[], it: Item): Column | undefined {
  const mid = it.x + it.w / 2, right = it.x + it.w;
  const singles = cols.filter((c) => c.kind === "single");
  const firstGroup = cols.find((c) => c.kind === "cnt");
  if (singles.length && (!firstGroup || right < firstGroup.from + 1)) {
    return singles.reduce((best, c) => {
      const d = mid < c.from ? c.from - mid : mid > c.to ? mid - c.to : 0;
      const bd = mid < best.from ? best.from - mid : mid > best.to ? mid - best.to : 0;
      return d < bd ? c : best;
    });
  }
  return cols.find((c) => c.kind !== "single" && right > c.from && right <= c.to + 0.5) ?? cols.find((c) => c.kind === "tail" && right > c.from);
}

export async function pdfTable(buf: Buffer): Promise<ReportTable | undefined> {
  let pages: Item[][];
  try { pages = await itemsOf(buf); } catch { return undefined; }
  let title = "", subtitle: string[] = [];
  const rows: ReportRow[] = [];
  let columns: string[] = [];
  for (const items of pages) {
    const layout = columnsOf(items);
    if (!layout) continue;
    const { cols, headerBottom } = layout;
    if (!columns.length) {
      columns = [...new Set(cols.map((c) => c.name))];
      const above = items.filter((i) => i.y < headerBottom - 34).sort((a, b) => a.y - b.y);
      title = above[0]?.s ?? "";
      subtitle = above.slice(1, 4).map((i) => i.s);
    }
    // Footer: the date, page number and printed-by line at the bottom.
    const footer = Math.min(...items.filter((i) => /^Page \d+ of \d+$/i.test(i.s)).map((i) => i.y), Infinity) - 6;
    const body = items.filter((i) => i.y > headerBottom && i.y < footer);
    const iss = cols.find((c) => c.kind === "single");
    // A row starts on a line with a number in the first column (Iss); its percentages are on the next line down.
    const lines = [...new Set(body.map((i) => Math.round(i.y)))].sort((a, b) => a - b);
    const starts = lines.filter((y) => body.some((i) => Math.abs(i.y - y) < 1.5 && isNum(i.s) && columnFor(cols, i) === iss));
    for (const [k, y] of starts.entries()) {
      const next = starts[k + 1] ?? footer;
      const inRow = body.filter((i) => i.y >= y - 1.5 && i.y < next - 1.5);
      const nameParts = inRow.filter((i) => i.x < (iss?.from ?? 50) - 2 && !isNum(i.s)).sort((a, b) => a.y - b.y);
      // Names wrap inside a narrow column ("Dickinso" / "n, Lucas", "Diliberto" / "," / "Dominic"): pieces are joined
      // without a space unless one ends or starts with a comma.
      const name = nameParts.map((i) => i.s).reduce((acc, s) => (!acc ? s : /,$/.test(acc) || /^,/.test(s) ? `${acc}${s}` : /^[a-z]/.test(s) ? `${acc}${s}` : `${acc} ${s}`), "").replace(/\s*,\s*/g, ", ").replace(/[:,]\s*$/, "").trim();
      const cells: Record<string, Cell> = {};
      const secondY = inRow.filter((i) => i.y > y + 4 && isNum(i.s)).map((i) => i.y).sort((a, b) => a - b)[0];
      for (const it of inRow) {
        if (!isNum(it.s)) continue;
        const col = columnFor(cols, it);
        if (!col) continue;
        const key = col.kind === "cnt" ? `${col.name} count` : col.kind === "vol" ? `${col.name} $` : col.name;
        const cell = (cells[key] ??= {});
        if (Math.abs(it.y - y) < 1.5) cell.main = it.s; else if (secondY !== undefined && Math.abs(it.y - secondY) < 1.5) cell.second = it.s;
      }
      // Cells in the report's own column order.
      const order = cols.map((c) => (c.kind === "cnt" ? `${c.name} count` : c.kind === "vol" ? `${c.name} $` : c.name));
      const sorted = Object.fromEntries(Object.entries(cells).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));
      for (const k of Object.keys(cells)) delete cells[k];
      Object.assign(cells, sorted);
      const total = /^total/i.test(name);
      // A row that continues on the next page (its name was printed on the last page) is joined to the one before.
      rows.push({ name: name || (rows.length ? `${rows[rows.length - 1]!.name} (continued)` : "(no name)"), total, cells });
    }
  }
  return rows.length ? { title, subtitle, columns, rows } : undefined;
}

const num = (s?: string) => { if (!s) return 0; const n = Number(s.replace(/[$,%]/g, "")); return Number.isFinite(n) ? n : 0; };
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");

/** The table as plain lines an agent reads, one per rep, every number labelled with its column. */
export function tableText(t: ReportTable): string {
  const line = (r: ReportRow) => {
    const parts: string[] = [];
    for (const [k, c] of Object.entries(r.cells)) parts.push(`${k} ${c.main ?? "–"}${c.second ? ` [${c.second}]` : ""}`);
    return `${r.name}: ${parts.join(" · ")}`;
  };
  return [`${t.title}${t.subtitle.length ? ` (${t.subtitle.join("; ")})` : ""}`, "Every number is labelled with its column; [brackets] is the second line under it (a percentage, or under Close $ the average sale). A column not listed for a rep is blank in the report.", ...t.rows.map(line)].join("\n");
}

/**
 * Phil's numbers from Sales Efficiency by Sales Rep (his definitions, Nov 16 2026), worked out by HQ rather than by an
 * agent reading columns:
 *   close to issue = Close count ÷ Iss (Marino 7 ÷ 14 = 50%); the report's own Close % is close to demo, not used
 *   demo rate      = the report's Sit / demo % (demos ÷ net issued)
 *   NSLI           = (Net $ + 70% of Pre-net $) ÷ Iss. Not the report's own NSLI column, which leaves pre-net out
 *                    (Phil, Nov 16: "technically incorrect for our NSLI because it doesn't include the pre-net")
 *   cancel rate    = Cancelled count ÷ Close count; credit declines are not cancels
 *   pending        = Pre-net (count and $); about 70% of pre-net goes net, so projected net = Net $ + 70% of Pre-net $
 */
export function salesEfficiency(t: ReportTable): string | undefined {
  const has = (k: string) => t.rows.some((r) => k in r.cells);
  if (!/sales efficiency/i.test(t.title) || !has("Iss") || !has("Close count")) return undefined;
  const head = "| Rep | Issued | Sold | Close to issue | Demo rate | NSLI (net + 70% of pre-net, ÷ issued) | Cancels | Cancel rate | Pending (pre-net) | Net | Projected net (net + 70% of pre-net) |\n|---|---|---|---|---|---|---|---|---|---|---|";
  const row = (r: ReportRow) => {
    const c = r.cells;
    const iss = num(c.Iss?.main), sold = num(c["Close count"]?.main), cancels = num(c["Cancelled count"]?.main);
    const net = num(c["Net $"]?.main), pre = num(c["Pre-net $"]?.main), preN = num(c["Pre-net count"]?.main);
    const projected = net + 0.7 * pre;
    const nsli = iss ? `${money(projected / iss)}` : "n/a";
    const demo = c["Sit / demo"]?.second ?? (c["Net Iss/opp"]?.main ? pct(num(c["Sit / demo"]?.main), num(c["Net Iss/opp"]?.main)) : "n/a");
    return `| ${r.total ? "**Team**" : r.name} | ${iss} | ${sold} | ${pct(sold, iss)} (${sold} ÷ ${iss}) | ${demo} (${num(c["Sit / demo"]?.main)} demo${num(c["Sit / demo"]?.main) === 1 ? "" : "s"}) | ${nsli} | ${cancels} | ${sold ? pct(cancels, sold) : "n/a"} | ${preN} · ${money(pre)} | ${money(net)} | ${money(projected)} |`;
  };
  const total = t.rows.find((r) => r.total);
  return [`Phil's numbers, worked out by HQ from the report (close to issue = sold ÷ issued; demo rate = the report's Sit / demo %; NSLI = (net + 70% of pre-net) ÷ issued, not the report's own NSLI column, which leaves pre-net out; cancel rate = cancelled ÷ sold, credit declines not counted; pending = pre-net, ~70% of which goes net). Use these numbers as they are:`, head, ...(total ? [row(total)] : []), ...t.rows.filter((r) => !r.total).map(row)].join("\n");
}
