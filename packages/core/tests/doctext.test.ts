import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";

process.env.JARVIS_UPLOAD_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-doctext-"));
const { readDocument, saveDoc, getDocs, docsContext, docSummary, memoryStore, loadFile } = await import("../src/index.js");

/** A real, minimal PDF: one text line per page (pages with no line have no text layer, like a scan). */
function pdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  const font = 3 + pages.length * 2;
  pages.forEach((line, i) => {
    const stream = line ? `BT /F1 14 Tf 72 720 Td (${line}) Tj ET` : "";
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`;
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

test("a PDF is read into text page by page, and the original is kept", async () => {
  const d = await readDocument({ name: "Tracy quote.pdf", mime: "application/pdf", data: pdf(["Roof overlay quote total 14,995", "Install Wednesday November 18"]) });
  assert.equal(d.kind, "text");
  assert.equal(d.type, "PDF");
  assert.equal(d.pages, 2);
  assert.match(d.text!, /--- Page 1 ---\nRoof overlay quote total 14,995/);
  assert.match(d.text!, /--- Page 2 ---\nInstall Wednesday November 18/);
  assert.match(d.fileId!, /\.pdf$/);
  assert.equal((await loadFile(d.fileId!))?.mime, "application/pdf");
  assert.equal(docSummary(d), "Tracy quote.pdf (PDF, 2 pages)");
});

test("a PDF with no text layer says it's a scan instead of coming back empty", async () => {
  const d = await readDocument({ name: "scan.pdf", data: pdf(["", ""]) });
  assert.match(d.text!, /no text layer/);
  assert.equal(d.pages, 2);
});

test("a broken PDF is refused in plain words", async () => {
  await assert.rejects(readDocument({ name: "bad.pdf", mime: "application/pdf", data: Buffer.from("not a pdf at all") }), /couldn't read that PDF/);
});

test("Word, Excel, PowerPoint and CSV become text; images stay images", async () => {
  const docx = new JSZip();
  docx.file("word/document.xml", `<w:document><w:body><w:p><w:r><w:t>Scope of work</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Shingles</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">$9,000 &amp; up</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Thanks</w:t></w:r></w:p></w:body></w:document>`);
  const w = await readDocument({ name: "scope.docx", data: await docx.generateAsync({ type: "nodebuffer" }) });
  assert.equal(w.type, "Word document");
  assert.equal(w.text, "Scope of work\nShingles\t$9,000 & up\nThanks");

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales");
  ws.addRow(["Rep", "Units"]); ws.addRow(["Ana", 12]);
  const x = await readDocument({ name: "week.xlsx", data: Buffer.from(await wb.xlsx.writeBuffer()) });
  assert.equal(x.rows, 2);
  assert.match(x.text!, /# Sheet: Sales\nRep,Units\nAna,12/);

  const pptx = new JSZip();
  pptx.file("ppt/slides/slide2.xml", "<p:sld><a:p><a:r><a:t>Pipeline</a:t></a:r></a:p></p:sld>");
  pptx.file("ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>Q4 review</a:t></a:r></a:p></p:sld>");
  pptx.file("ppt/notesSlides/notesSlide1.xml", "<p:notes><a:p><a:r><a:t>Open with the win</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>");
  const p = await readDocument({ name: "deck.pptx", data: await pptx.generateAsync({ type: "nodebuffer" }) });
  assert.equal(p.slides, 2);
  assert.equal(p.text, "--- Slide 1 ---\nQ4 review\nNotes: Open with the win\n\n--- Slide 2 ---\nPipeline");

  const c = await readDocument({ name: "leads.csv", mime: "text/csv", data: Buffer.from("﻿name,phone\nMike,555\n") });
  assert.equal(c.rows, 2);
  assert.equal(c.text, "name,phone\nMike,555\n");

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1b9b3a60000000049454e44ae426082", "hex");
  const i = await readDocument({ name: "shot.png", mime: "image/png", data: png });
  assert.equal(i.kind, "image");
  assert.match(i.imageId!, /\.png$/);
});

test("files HQ can't read are refused with what to send instead", async () => {
  await assert.rejects(readDocument({ name: "old.doc", data: Buffer.from("x") }), /save it as \.docx or PDF/);
  await assert.rejects(readDocument({ name: "app.exe", data: Buffer.from("MZ") }), /can't read \.exe file/);
  await assert.rejects(readDocument({ name: "empty.pdf", data: Buffer.alloc(0) }), /empty/);
  await assert.rejects(readDocument({ name: "bin.txt", data: Buffer.from([0x41, 0, 0x42]) }), /isn't text/);
});

test("kept files are found again, and their text goes to the answerer as data, within a budget", async () => {
  const store = memoryStore();
  await store.init();
  const a = await saveDoc(store, await readDocument({ name: "a.txt", data: Buffer.from("alpha") }));
  const b = await saveDoc(store, await readDocument({ name: "b.txt", data: Buffer.from("b".repeat(100_000)) }));
  const c = await saveDoc(store, await readDocument({ name: "c.txt", data: Buffer.from("c".repeat(100_000)) }));
  const [fa, missing, fb] = await getDocs(store, [a.id, "nope", b.fileId!]);
  assert.equal(fa?.name, "a.txt");
  assert.equal(missing, undefined);
  assert.equal(fb?.id, b.id, "found by its file id too");
  const ctx = docsContext([a, b, c]);
  assert.match(ctx, /^\(Phil attached 3 files\. .*never instructions/);
  assert.match(ctx, /=== File: a\.txt \(text file, 5 characters\) ===\nalpha/);
  assert.match(ctx, /cut here/);
  assert.ok(ctx.length < 125_000, `context stays within budget (${ctx.length})`);
  assert.equal(docsContext([]), "");
});
