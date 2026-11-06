import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { memoryStore, Jarvis, getAgent, normalizeDeck, renderDeck, parseTemplate, setTemplate, getTemplate, listDecks, deckFile, addDataFile, listDataFiles, removeDataFile, dataText, extractBlocks, SCHEDULES } from "../src/index.js";

process.env.JARVIS_UPLOAD_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-decks-"));

const spec = {
  title: "ProEdge weekly sales",
  subtitle: "Week of Nov 2",
  slides: [
    { title: "At a glance", stats: [{ label: "Revenue", value: "$42,300", change: "+12%" }, { label: "Close rate", value: "31%", change: "-2 pts" }], bullets: ["Up on installs"], notes: "Lead with revenue." },
    { title: "By day", chart: { type: "bar", labels: ["Mon", "Tue"], series: [{ name: "Sales", values: [1200, "900"] }] } },
    { title: "By rep", table: { columns: ["Rep", "Closed"], rows: [["Ana", 5], ["Ben", 3]] } },
    { nope: true },
  ],
};

test("decks: a slides block becomes a real .pptx, and a template's colours, fonts and order are read back", async () => {
  const { slides, text } = extractBlocks(`Headlines.\n\n\`\`\`slides\n${JSON.stringify(spec)}\n\`\`\``);
  assert.equal(text, "Headlines.");
  const d = normalizeDeck(slides[0]);
  assert.ok(d);
  assert.equal(d.slides.length, 3, "a slide without a title is dropped");
  assert.deepEqual(d.slides[1]!.chart!.series[0]!.values, [1200, 900]);
  assert.equal(normalizeDeck({ slides: [] }), undefined);

  const buf = await renderDeck(d);
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file("ppt/slides/slide4.xml"), "cover plus three slides");
  assert.match((await zip.file("ppt/slides/slide2.xml")!.async("string")), /\$42,300/);

  // The deck itself works as a template: its slide text comes back in order.
  const t = await parseTemplate(buf);
  assert.equal(t.wide, true);
  assert.match(t.outline[0]!, /ProEdge weekly sales/);
  assert.match(t.outline[2]!, /By day/);
  await assert.rejects(parseTemplate(Buffer.from("not a zip")), /isn't a PowerPoint/);
});

test("sales data: CSV and Excel are read into text, Stevon builds the deck, and it's kept with a download", async () => {
  const store = memoryStore(); await store.init();
  const csv = await addDataFile(store, "proedge", { name: "week.csv", mime: "text/csv", data: Buffer.from("rep,closed,revenue\nAna,5,14900\nBen,3,9100\n") });
  assert.equal(csv.rows, 3);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales");
  ws.addRow(["Rep", "Revenue", "Date"]); ws.addRow(["Cal", { formula: "1000*2", result: 2000 }, new Date("2026-11-03T00:00:00Z")]);
  const xl = await addDataFile(store, "proedge", { name: "week.xlsx", data: Buffer.from(await wb.xlsx.writeBuffer()) });
  assert.match(xl.text!, /# Sheet: Sales\nRep,Revenue,Date\nCal,2000,2026-11-03/);
  await assert.rejects(addDataFile(store, "proedge", { name: "report.pdf", mime: "application/pdf", data: Buffer.from("%PDF") }), /PDFs can't be read/);
  const text = dataText(await listDataFiles(store, "proedge", 8), 8);
  assert.match(text, /2 file\(s\)/);
  assert.match(text, /Ana,5,14900/);
  assert.equal(await removeDataFile(store, "proedge", csv.id), true);
  assert.equal((await listDataFiles(store, "proedge")).length, 1);

  // Template upload for ProEdge.
  const tpl = await setTemplate(store, "proedge", "Tuesday.pptx", await renderDeck(normalizeDeck(spec)!));
  assert.equal((await getTemplate(store, "proedge"))!.fileId, tpl.fileId);

  // The routine exists, pushes, and runs Monday night.
  const r = SCHEDULES.find((s) => s.id === "stevon-weekly")!;
  assert.equal(r.when, "weekly:mon@20:00");
  assert.ok(r.push);

  const j = new Jarvis({ store });
  const out = await j.runAgent(getAgent("stevon")!, "Build the deck for Tuesday's meeting.", { direct: true });
  assert.equal(out.decks?.length, 1);
  assert.match(out.text, /\[Deck ready: ProEdge weekly sales\]/);
  const decks = await listDecks(store, "proedge");
  assert.equal(decks.length, 1);
  const f = await deckFile(store, decks[0]!.id);
  assert.ok(f && f.data.length > 1000);
  assert.match(f.name, /^ProEdge weekly sales \d{4}-\d{2}-\d{2}\.pptx$/);
  const msgs = await store.chat.list(20);
  assert.ok(msgs.some((m) => m.files?.[0]?.id === decks[0]!.id), "the deck is handed over in chat");
});
