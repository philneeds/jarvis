import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfTable, tableText, salesEfficiency } from "../src/reportpdf.js";

/**
 * A LeadPerfection report read column by column. The stand-in PDF puts every piece of text where the real Sales
 * Efficiency by Sales Rep report does (the same x positions), with made-up reps and numbers, and with empty cells,
 * which is what made plain text slide numbers into the wrong columns.
 */
type P = [string, number, number]; // text, x, y from the top
function pdfAt(pages: P[][]): Buffer {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  const font = 3 + pages.length * 2;
  pages.forEach((items, i) => {
    const stream = items.map(([s, x, y]) => `BT /F1 8 Tf 1 0 0 1 ${x} ${612 - y} Tm (${s.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`;
    objs[4 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objs[font] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) { offsets[n] = out.length; out += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const HEADER: P[] = [
  ["Sales Efficiency by Sales Rep", 286, 43], ["For Appointment Dates Between Sun 11/01/26 and Mon 11/16/26", 294, 61], ["Market: --ALL--", 400, 75],
  ["Sales", 7, 108], ["Rep", 7, 118], ["Iss", 56, 118], ["Net", 81, 98], ["Iss/", 77, 108], ["opp", 80, 118], ["Sit /", 108, 108], ["demo", 103, 118],
  ["Close", 162, 109], ["Pre-net", 229, 109], ["On-Hold", 303, 109], ["Cancelled", 375, 109], ["Credit Decline", 441, 109], ["Backlog", 531, 109], ["Complete", 603, 109], ["Net", 695, 109], ["NSLI", 762, 100], ["NCP", 765, 114],
  ...[149, 216, 292, 368, 443, 519, 595, 671].map((x) => ["%Cnt", x, 119] as P), ...[190, 262, 338, 413, 489, 565, 641, 716].map((x) => ["%Vol", x, 119] as P),
];
const FOOT: P[] = [["11/16/2026 12:49PM", 7, 571], ["Page 1 of 1", 376, 571], ["Report runner", 709, 571]];

test("each number lands in the column it sits under, blanks stay blank, and Phil's numbers are worked out", async () => {
  const rows: P[] = [
    // A rep with sales in Pre-net, Cancelled and Backlog but none in Credit Decline: the blank must not shift Backlog left.
    ["Lane,", 7, 134], ["Avery", 7, 144], ["14", 60, 134], ["13", 90, 134], ["10", 123, 134], ["7", 155, 134], ["110,000", 178, 134], ["1", 227, 134], ["20,000", 255, 134], ["4", 378, 134], ["60,000", 402, 134], ["2", 530, 134], ["30,000", 558, 134], ["2", 684, 134], ["30,000", 714, 134], ["2,143", 760, 134],
    ["93%", 82, 147], ["77%", 109, 147], ["70%", 148, 147], ["15,714 100%", 183, 147], ["18%", 265, 147], ["57%", 372, 147], ["29%", 523, 147], ["29%", 679, 147], ["14%", 770, 147],
    // A name that wraps on three lines, and a credit decline only.
    ["Quill", 7, 170], [",", 7, 180], ["Morgan", 7, 188], ["8", 66, 170], ["8", 96, 170], ["6", 128, 170], ["1", 155, 170], ["40,000", 183, 170], ["1", 454, 170], ["40,000", 481, 170],
    ["100%", 76, 183], ["75%", 109, 183], ["17%", 148, 183], ["40,000", 183, 183], ["100%", 442, 183], ["100%", 483, 183],
    // Totals.
    ["22", 55, 210], ["21", 85, 210], ["16", 117, 210], ["8", 155, 210], ["150,000", 178, 210], ["1", 227, 210], ["20,000", 255, 210], ["4", 378, 210], ["60,000", 402, 210], ["1", 454, 210], ["40,000", 481, 210], ["2", 530, 210], ["30,000", 558, 210], ["2", 684, 210], ["30,000", 714, 210], ["1,364", 760, 210],
    ["Total:", 7, 219], ["95%", 82, 223], ["76%", 109, 223], ["50%", 148, 223], ["18,750", 183, 223],
  ];
  const t = (await pdfTable(pdfAt([[...HEADER, ...rows, ...FOOT]])))!;
  assert.ok(t, "read as a table");
  assert.equal(t.title, "Sales Efficiency by Sales Rep");
  assert.deepEqual(t.columns, ["Iss", "Net Iss/opp", "Sit / demo", "Close", "Pre-net", "On-Hold", "Cancelled", "Credit Decline", "Backlog", "Complete", "Net", "NSLI / NCP"]);
  assert.deepEqual(t.rows.map((r) => r.name), ["Lane, Avery", "Quill, Morgan", "Total"]);
  const lane = t.rows[0]!.cells;
  assert.equal(lane.Iss?.main, "14");
  assert.equal(lane["Net Iss/opp"]?.main, "13");
  assert.equal(lane["Sit / demo"]?.main, "10");
  assert.deepEqual(lane["Close $"], { main: "110,000", second: "15,714" });
  assert.equal(lane["Pre-net count"]?.second, "100%", "a merged \"15,714 100%\" is split into its two columns");
  assert.equal(lane["Cancelled count"]?.main, "4");
  assert.equal(lane["Credit Decline count"], undefined, "a blank cell stays blank");
  assert.equal(lane["Backlog $"]?.main, "30,000");
  assert.equal(lane["Net $"]?.main, "30,000");
  assert.equal(lane["NSLI / NCP"]?.main, "2,143");
  assert.equal(t.rows[1]!.cells["Credit Decline $"]?.main, "40,000");
  assert.equal(t.rows[1]!.cells["Cancelled count"], undefined);
  assert.equal(t.rows[2]!.total, true);
  const text = tableText(t);
  // The report's own Close % (sold ÷ demos) and NSLI are labelled as not Phil's, so they can't end up on a slide (Nov 21).
  assert.match(text, /^Lane, Avery: Iss 14 · Net Iss\/opp 13 \[93%\] · Sit \/ demo 10 \[77%\] · Sold 7 \[the report's Close % = sold ÷ demos 70%: NOT Phil's close rate, which is close to issue \(sold ÷ net issued\), in the table above\] · Close \$ 110,000 \[15,714\]/m);
  assert.match(text, /NSLI \/ NCP \(the report's, leaves pre-net out: NOT Phil's NSLI\) 2,143/);
  const nums = salesEfficiency(t)!;
  // close to issue 7 ÷ 13 net issued (Phil, Nov 21: on net issued); demo rate the report's 77%; NSLI (30,000 + 0.7 × 20,000) ÷ 14 = 3,143; cancels 4 ÷ 7; credit declines not cancels.
  assert.match(nums, /\| Lane, Avery \| 14 \| 7 \| 53\.8% \(7 ÷ 13 net issued\) \| 77% \(10 demos\) \| \$3,143 \| 4 \| 57\.1% \| 1 · \$20,000 \| \$30,000 \| \$44,000 \|/);
  assert.match(nums, /\| Quill, Morgan \| 8 \| 1 \| 12\.5% \(1 ÷ 8 net issued\) \| 75% \(6 demos\) \| \$0 \| 0 \| 0\.0% \| 0 · \$0 \| \$0 \| \$0 \|/);
  assert.match(nums, /\| \*\*Team\*\* \| 22 \| 8 \| 38\.1% \(8 ÷ 21 net issued\) \| 76% \(16 demos\) \| \$2,000 \| 4 \| 50\.0% \| 1 · \$20,000 \| \$30,000 \| \$44,000 \|/);
  assert.doesNotMatch(nums, /\$1,364/, "the report's own NSLI (no pre-net) isn't used");
  // The same report as numbers HQ writes onto a deck: {{codes}} filled from it, with Phil's formulas.
  const { salesRows, fillNumbers } = await import("../src/salesnumbers.js");
  const sr = salesRows(t)!;
  const week = { start: "11/09/2026", end: "11/15/2026", at: "x", ...sr };
  const prior = { ...week, start: "11/02/2026", end: "11/08/2026", team: { ...sr.team!, sold: 4 } };
  const f = (s: string) => fillNumbers(s, { week, prior });
  assert.deepEqual(f("Close {{close}} · demo {{demo|0}} · NSLI {{nsli}} · {{gross}} · {{week}} vs {{prior.week}} ({{prior.close}})"), { text: "Close 38.1% · demo 76% · NSLI $2,000 · $150,000 · 11/09–11/15 vs 11/02–11/08 (19.0%)", errors: [] });
  assert.equal(f("{{rep:Lane.close}} {{rep:quill.demos}}").text, "53.8% 6");
  assert.equal(f("1. {{top.close.1.rep}} {{top.close.1}} · 2. {{top.close.2.rep}} {{top.close.2}}").text, "1. Lane, Avery 53.8% · 2. Quill, Morgan 12.5%");
  assert.equal(f("{{top.close.3.rep}}").text, "", "past the end of the board: blank");
  // A board's other columns for the same rep, and a rep's share of the team (the volume board's "% of Team").
  const best = sr.reps.slice().sort((a, b) => b.gross - a.gross)[0]!;
  const share = Math.round((best.gross / sr.team!.gross) * 100);
  assert.equal(f("{{top.gross.1.rep}} {{top.gross.1.gross_share|0}} {{top.gross.1.sold}}").text, [best.rep, `${share}%`, String(best.sold)].join(" "));
  assert.match(f("{{top.gross.1.nope}}").errors[0]!, /no figure called "nope"/);
  assert.equal(f("across {{reps}} reps").text, `across ${sr.reps.filter((r) => r.issued > 0).length} reps`);
  const bad = f("{{rep:Nobody.close}} {{closing}}");
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0]!, /no rep "Nobody" in the 11\/09–11\/15 report \(reps: Lane, Avery; Quill, Morgan\)/);
  assert.match(bad.errors[1]!, /no figure called "closing"/);
  assert.match(fillNumbers("{{prior.close}}", { week }).errors[0]!, /no lp_report pull of Sales Efficiency for the week before/);
});

test("a PDF that isn't a column report reads as nothing here, so the plain text is used", async () => {
  assert.equal(await pdfTable(pdfAt([[["Just a letter", 72, 100], ["with two lines", 72, 120]]])), undefined);
  assert.equal(await pdfTable(Buffer.from("not a pdf")), undefined);
});

test("a deck's two weeks: the newest team-wide pull and the one before it, or the dates the deck names", async () => {
  const { memoryStore, saveSalesPull, pullsFor } = await import("../src/index.js");
  const store = memoryStore(); await store.init();
  const p = (start: string, end: string, extra = {}) => ({ start, end, at: new Date().toISOString(), reps: [], ...extra });
  await saveSalesPull(store, p("11/02/2026", "11/08/2026"));
  await saveSalesPull(store, p("11/09/2026", "11/15/2026"));
  await saveSalesPull(store, p("11/09/2026", "11/15/2026", { market: "NYW" }));
  await saveSalesPull(store, p("10/26/2026", "11/01/2026"));
  const d = await pullsFor(store);
  assert.equal(`${d.week?.start} ${d.week?.market ?? ""}`, "11/09/2026 ", "the newest team-wide week, not one market");
  assert.equal(d.prior?.start, "11/02/2026", "and the week right before it");
  const named = await pullsFor(store, { week: "11/02/2026-11/08/2026", prior: "10/26/2026 - 11/01/2026" });
  assert.equal(named.week?.start, "11/02/2026"); assert.equal(named.prior?.start, "10/26/2026");
});
