import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store/types.js";
import { defineTool, type ToolDef } from "./tools/index.js";
import { getAgent } from "./registry/index.js";
import { saveFile, saveImage, removeFile, imageMimeOk } from "./uploads.js";
import { getTemplate, templateText, listDecks, DECK_HINT } from "./decks.js";

/**
 * The sales data Phil uploads each week for Stevon's Tuesday meeting deck: spreadsheets (CSV or Excel) read into
 * text, and screenshots kept as images Stevon can see. Kept per venture (ProEdge for now), last 40 files.
 */
export interface DataFile { id: string; venture: string; name: string; at: string; kind: "table" | "image"; fileId?: string; imageId?: string; rows?: number; text?: string; note?: string }

const KEY = (venture: string) => `data.files.${venture}`;
const MAX_TEXT = 120_000;

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[]; error?: unknown; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.result !== undefined) return cellText(o.result as ExcelJS.CellValue);
    if (o.text !== undefined) return String(o.text);
    if (o.error !== undefined) return String(o.error);
    return "";
  }
  return String(v);
};
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** An Excel workbook as CSV text, one block per sheet. */
export async function xlsxToText(buf: Buffer): Promise<{ text: string; rows: number }> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { throw new Error("couldn't read that Excel file (save it as .xlsx or .csv)"); }
  const parts: string[] = [];
  let rows = 0;
  wb.eachSheet((ws) => {
    const lines: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
      while (vals.length && !vals[vals.length - 1]) vals.pop();
      if (vals.length) { lines.push(vals.map(csvCell).join(",")); rows++; }
    });
    if (lines.length) parts.push(`# Sheet: ${ws.name}\n${lines.join("\n")}`);
  });
  return { text: parts.join("\n\n"), rows };
}

const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";

/** Keep one uploaded file. Spreadsheets become text; images stay images. */
export async function addDataFile(store: Store, venture: string, f: { name: string; mime?: string; data: Buffer; note?: string }): Promise<DataFile> {
  const e = ext(f.name), mime = (f.mime ?? "").split(";")[0]!.trim().toLowerCase();
  const base = { id: randomUUID(), venture, name: f.name.slice(0, 160), at: new Date().toISOString(), note: f.note?.slice(0, 500) || undefined };
  let file: DataFile;
  if (imageMimeOk(mime)) {
    file = { ...base, kind: "image", imageId: await saveImage(f.data, mime) };
  } else if (e === "xlsx" || mime.includes("spreadsheetml")) {
    const { text, rows } = await xlsxToText(f.data);
    file = { ...base, kind: "table", fileId: await saveFile(f.data, "xlsx"), rows, text: text.slice(0, MAX_TEXT) };
  } else if (["csv", "tsv", "txt"].includes(e) || mime.startsWith("text/")) {
    const text = f.data.toString("utf8").replace(/^﻿/, "");
    file = { ...base, kind: "table", fileId: await saveFile(f.data, e === "txt" ? "txt" : "csv"), rows: text.split(/\r?\n/).filter((l) => l.trim()).length, text: text.slice(0, MAX_TEXT) };
  } else if (e === "xls") {
    throw new Error("old .xls files can't be read; save it as .xlsx or .csv");
  } else if (e === "pdf" || mime === "application/pdf") {
    throw new Error("PDFs can't be read yet; send the spreadsheet (.xlsx or .csv) or a screenshot");
  } else {
    throw new Error("send a spreadsheet (.xlsx or .csv) or a screenshot");
  }
  const all = await store.settings.get<DataFile[]>(KEY(venture), []);
  const next = [...all, file].slice(-40);
  for (const old of all.slice(0, Math.max(0, all.length + 1 - 40))) { if (old.fileId) await removeFile(old.fileId); if (old.imageId) await removeFile(old.imageId); }
  await store.settings.set(KEY(venture), next);
  return file;
}

export async function listDataFiles(store: Store, venture: string, days?: number): Promise<DataFile[]> {
  const all = await store.settings.get<DataFile[]>(KEY(venture), []);
  const since = days ? Date.now() - days * 86_400_000 : 0;
  return all.filter((f) => Date.parse(f.at) >= since).reverse();
}

export async function removeDataFile(store: Store, venture: string, id: string): Promise<boolean> {
  const all = await store.settings.get<DataFile[]>(KEY(venture), []);
  const f = all.find((x) => x.id === id);
  if (!f) return false;
  if (f.fileId) await removeFile(f.fileId);
  if (f.imageId) await removeFile(f.imageId);
  await store.settings.set(KEY(venture), all.filter((x) => x.id !== id));
  return true;
}

/** Screenshots from the period, for agents that can see. */
export async function recentDataImages(store: Store, venture: string, days = 8): Promise<string[]> {
  return (await listDataFiles(store, venture, days)).filter((f) => f.imageId).map((f) => f.imageId!).slice(0, 3);
}

const eastern = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function dataText(files: DataFile[], days: number): string {
  if (!files.length) return `No sales data uploaded in the last ${days} days.`;
  let budget = 90_000;
  const out = [`${files.length} file(s) uploaded in the last ${days} days, newest first:`];
  for (const f of files) {
    out.push(`\n## ${f.name} · uploaded ${eastern(f.at)}${f.rows ? ` · ${f.rows} rows` : ""}${f.note ? ` · Phil's note: ${f.note}` : ""}`);
    if (f.kind === "image") { out.push("(a screenshot, attached to this conversation as an image)"); continue; }
    const t = (f.text ?? "").slice(0, Math.max(0, budget));
    budget -= t.length;
    out.push(t || "(cut: too much data this period; ask Phil which file matters)");
  }
  return out.join("\n");
}

export const DATA_TOOLS: ToolDef[] = [
  defineTool({
    name: "sales_data",
    description: "The sales data Phil uploaded for your venture (spreadsheets as CSV text, screenshots attached as images), newest first. days=8 for this week; days=15 to compare with last week.",
    schema: { days: z.number().int().min(1).max(60).optional() },
    async handler({ days }, { store, agentId }) { const d = days ?? 8; return dataText(await listDataFiles(store, getAgent(agentId)?.venture ?? "proedge", d), d); },
  }),
  defineTool({
    name: "deck_template",
    description: "Phil's presentation template for your venture (slide order and section names to follow), and the last decks made.",
    schema: {},
    async handler(_a, { store, agentId }) {
      const v = getAgent(agentId)?.venture ?? "proedge";
      const decks = (await listDecks(store, v)).slice(0, 3);
      return `${templateText(await getTemplate(store, v))}\n\nLast decks: ${decks.length ? decks.map((d) => `${d.title} (${d.at.slice(0, 10)}, ${d.slides} slides)`).join("; ") : "none yet"}.`;
    },
  }),
];

export { DECK_HINT };
