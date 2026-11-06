import PptxModule from "pptxgenjs";
import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import type { Store } from "./store/types.js";
import { saveFile, loadFile } from "./uploads.js";

/**
 * Presentations agents make. An agent writes the deck as a fenced ```slides block of JSON (DeckSpec); HQ turns it
 * into a .pptx, keeps it, and hands it to Phil in chat and on Telegram. A venture can have a template (a .pptx Phil
 * uploads): its colours, fonts and slide order are followed. Backgrounds and logos in the template aren't copied.
 */
export interface DeckStat { label: string; value: string; change?: string }
export interface DeckChart { type: "bar" | "line" | "pie"; title?: string; labels: string[]; series: { name: string; values: number[] }[] }
export interface DeckTable { columns: string[]; rows: (string | number)[][] }
export interface SlideSpec { title: string; bullets?: string[]; stats?: DeckStat[]; chart?: DeckChart; table?: DeckTable; notes?: string }
export interface DeckSpec { title: string; subtitle?: string; slides: SlideSpec[] }

export interface Deck { id: string; fileId: string; name: string; title: string; agentId: string; venture: string; at: string; slides: number }
export interface DeckTemplate { fileId: string; name: string; at: string; colors: Record<string, string>; fonts: { heading?: string; body?: string }; wide: boolean; outline: string[] }

// The package is CommonJS; at runtime the default import is the class itself, while its typings put it under .default.
type Pptx = InstanceType<typeof PptxModule.default>;
const PptxGenJS = ((PptxModule as unknown as { default?: unknown }).default ?? PptxModule) as unknown as new () => Pptx;

const DECKS_KEY = "decks";
const templateKey = (venture: string) => `decks.template.${venture}`;

/** What agents that make decks are told, appended to their prompt. */
export const DECK_HINT = [
  "You can hand Phil a real PowerPoint deck. Write it as a fenced block tagged \"slides\" with JSON:",
  '{"title":"...","subtitle":"...","slides":[{"title":"...","stats":[{"label":"Revenue","value":"$42,300","change":"+12% vs last week"}],"chart":{"type":"bar|line|pie","title":"...","labels":["Mon","Tue"],"series":[{"name":"Sales","values":[1200,900]}]},"table":{"columns":["Rep","Closed"],"rows":[["Ana",5]]},"bullets":["..."],"notes":"what to say on this slide"}]}',
  "Every slide needs a title; use at most one of chart or table per slide, up to 4 stats, up to 6 short bullets, up to 12 table rows. Numbers in charts are plain numbers. Use only figures from the data; never invent one. HQ builds the file and sends it to Phil; outside the block, reply with the three headlines in a few lines.",
  "If a template exists (deck_template), follow its slide order and section names.",
].join("\n");

const hex = (c: string | undefined, d: string) => (c && /^[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : d);
const str = (v: unknown, max = 400) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").slice(0, max);

/** Tidy an agent's JSON into a deck that renders, dropping what doesn't fit. Undefined if there's nothing usable. */
export function normalizeDeck(raw: unknown): DeckSpec | undefined {
  const o = raw as Partial<DeckSpec> | undefined;
  if (!o || typeof o !== "object" || !Array.isArray(o.slides)) return undefined;
  const slides: SlideSpec[] = [];
  for (const s of o.slides.slice(0, 30) as Partial<SlideSpec>[]) {
    if (!s || typeof s !== "object" || !str(s.title)) continue;
    const out: SlideSpec = { title: str(s.title, 120) };
    if (Array.isArray(s.bullets)) out.bullets = s.bullets.map((b) => str(b, 240)).filter(Boolean).slice(0, 8);
    if (Array.isArray(s.stats)) out.stats = s.stats.filter((t) => t && str(t.label) && str(t.value)).slice(0, 4).map((t) => ({ label: str(t.label, 40), value: str(t.value, 24), change: str(t.change, 40) || undefined }));
    const c = s.chart;
    if (c && Array.isArray(c.labels) && Array.isArray(c.series)) {
      const labels = c.labels.map((l) => str(l, 40)).slice(0, 24);
      const series = c.series.filter((x) => x && Array.isArray(x.values)).slice(0, 6).map((x) => ({ name: str(x.name, 40) || "Value", values: labels.map((_, i) => { const n = Number(x.values[i]); return Number.isFinite(n) ? n : 0; }) }));
      if (labels.length && series.length) out.chart = { type: c.type === "line" || c.type === "pie" ? c.type : "bar", title: str(c.title, 80) || undefined, labels, series: c.type === "pie" ? series.slice(0, 1) : series };
    }
    const t = s.table;
    if (!out.chart && t && Array.isArray(t.columns) && Array.isArray(t.rows)) {
      const columns = t.columns.map((x) => str(x, 40)).slice(0, 8);
      if (columns.length) out.table = { columns, rows: t.rows.filter(Array.isArray).slice(0, 14).map((r) => columns.map((_, i) => str(r[i], 60))) };
    }
    if (s.notes) out.notes = str(s.notes, 2000);
    slides.push(out);
  }
  if (!slides.length) return undefined;
  return { title: str(o.title, 120) || slides[0]!.title, subtitle: str(o.subtitle, 160) || undefined, slides };
}

/** The .pptx bytes for a deck, in the template's colours and fonts when there is one. */
export async function renderDeck(spec: DeckSpec, tpl?: Pick<DeckTemplate, "colors" | "fonts" | "wide">): Promise<Buffer> {
  const pptx = new PptxGenJS();
  const wide = tpl?.wide ?? true;
  pptx.layout = wide ? "LAYOUT_WIDE" : "LAYOUT_4x3";
  const W = wide ? 13.333 : 10, H = 7.5, M = 0.5;
  const c = tpl?.colors ?? {};
  const ink = hex(c.dk1, "1F2430"), paper = hex(c.lt1, "FFFFFF"), dark = hex(c.dk2, ink), muted = "6B7280";
  const accents = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((k, i) => hex(c[k], ["FF9A3C", "2F6FEB", "17A673", "9B5DE5", "E5484D", "F2C94C"][i]!));
  const head = tpl?.fonts.heading ?? "Calibri", body = tpl?.fonts.body ?? "Calibri";

  const cover = pptx.addSlide();
  cover.background = { color: dark };
  cover.addShape("rect", { x: M, y: 3.05, w: 1.2, h: 0.08, fill: { color: accents[0] }, line: { color: accents[0] } });
  cover.addText(spec.title, { x: M, y: 1.6, w: W - 2 * M, h: 1.4, fontFace: head, fontSize: 40, bold: true, color: paper, valign: "bottom", fit: "shrink" });
  if (spec.subtitle) cover.addText(spec.subtitle, { x: M, y: 3.3, w: W - 2 * M, h: 0.8, fontFace: body, fontSize: 20, color: paper, valign: "top" });

  spec.slides.forEach((s, idx) => {
    const sl = pptx.addSlide();
    sl.background = { color: paper };
    sl.addText(s.title, { x: M, y: 0.3, w: W - 2 * M, h: 0.8, fontFace: head, fontSize: 28, bold: true, color: ink, valign: "middle", fit: "shrink" });
    sl.addShape("rect", { x: M, y: 1.12, w: 0.9, h: 0.05, fill: { color: accents[0] }, line: { color: accents[0] } });
    sl.addText(String(idx + 2), { x: W - M - 0.6, y: H - 0.45, w: 0.6, h: 0.3, fontFace: body, fontSize: 10, color: muted, align: "right" });
    let y = 1.4;
    if (s.stats?.length) {
      const n = s.stats.length, gap = 0.25, w = (W - 2 * M - gap * (n - 1)) / n;
      s.stats.forEach((t, i) => {
        const x = M + i * (w + gap);
        sl.addShape("roundRect", { x, y, w, h: 1.35, rectRadius: 0.08, fill: { color: "F5F6F8" }, line: { color: "E5E7EB" } });
        sl.addText(t.value, { x: x + 0.2, y: y + 0.12, w: w - 0.4, h: 0.6, fontFace: head, fontSize: 26, bold: true, color: accents[0], fit: "shrink" });
        sl.addText(t.label, { x: x + 0.2, y: y + 0.72, w: w - 0.4, h: 0.3, fontFace: body, fontSize: 12, color: muted });
        if (t.change) sl.addText(t.change, { x: x + 0.2, y: y + 0.98, w: w - 0.4, h: 0.28, fontFace: body, fontSize: 11, bold: true, color: /^\s*[-−–]/.test(t.change) ? "C2410C" : /^\s*\+/.test(t.change) ? "15803D" : muted });
      });
      y += 1.65;
    }
    const h = H - y - 0.6;
    const visual = s.chart || s.table;
    const bullets = s.bullets?.length ? s.bullets : undefined;
    const vw = visual && bullets ? (W - 2 * M) * 0.6 : W - 2 * M;
    if (s.chart) {
      const ch = s.chart;
      const type = ch.type === "line" ? pptx.ChartType.line : ch.type === "pie" ? pptx.ChartType.pie : pptx.ChartType.bar;
      sl.addChart(type, ch.series.map((x) => ({ name: x.name, labels: ch.labels, values: x.values })), {
        x: M, y, w: vw, h, chartColors: accents, showLegend: ch.type === "pie" || ch.series.length > 1, legendPos: "b", legendFontSize: 10,
        showTitle: !!ch.title, title: ch.title, titleFontSize: 14, titleColor: ink, catAxisLabelFontSize: 10, valAxisLabelFontSize: 10,
        catAxisLabelColor: muted, valAxisLabelColor: muted, valGridLine: { color: "E5E7EB", size: 0.5 }, showPercent: ch.type === "pie", showValue: ch.type !== "pie" && ch.labels.length <= 8, dataLabelFontSize: 9, lineSize: 2,
      });
    } else if (s.table) {
      const t = s.table;
      const rows = [t.columns.map((col) => ({ text: col, options: { bold: true, color: "FFFFFF", fill: { color: dark } } })), ...t.rows.map((r, i) => r.map((v) => ({ text: String(v), options: { fill: { color: i % 2 ? "F7F7F9" : "FFFFFF" } } })))];
      sl.addTable(rows, { x: M, y, w: vw, fontFace: body, fontSize: t.rows.length > 10 ? 10 : 12, color: ink, border: { type: "solid", color: "E5E7EB", pt: 0.5 }, autoPage: false, rowH: Math.min(0.42, h / (t.rows.length + 1)) });
    }
    if (bullets) {
      const x = visual ? M + vw + 0.4 : M;
      sl.addText(bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 }, paraSpaceAfter: 10 } })), { x, y, w: W - M - x, h, fontFace: body, fontSize: visual ? 16 : 20, color: ink, valign: "top", fit: "shrink" });
    }
    if (s.notes) sl.addNotes(s.notes);
  });
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

/** Read a .pptx template: theme colours and fonts, slide size, and each slide's text in order. */
export async function parseTemplate(buf: Buffer): Promise<Pick<DeckTemplate, "colors" | "fonts" | "wide" | "outline">> {
  const zip = await JSZip.loadAsync(buf).catch(() => { throw new Error("that isn't a PowerPoint (.pptx) file"); });
  const read = async (p: string) => (await zip.file(p)?.async("string")) ?? "";
  const theme = await read(Object.keys(zip.files).find((f) => /^ppt\/theme\/theme\d+\.xml$/.test(f)) ?? "ppt/theme/theme1.xml");
  const colors: Record<string, string> = {};
  for (const m of theme.matchAll(/<a:(dk1|lt1|dk2|lt2|accent[1-6])>\s*<a:(?:srgbClr val|sysClr [^>]*?lastClr)="([0-9A-Fa-f]{6})"/g)) colors[m[1]!] = m[2]!.toUpperCase();
  const font = (tag: string) => theme.match(new RegExp(`<a:${tag}>\\s*<a:latin typeface="([^"]+)"`))?.[1];
  const pres = await read("ppt/presentation.xml");
  const sz = pres.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
  const wide = sz ? Number(sz[1]) / Number(sz[2]) > 1.5 : true;
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  const outline: string[] = [];
  for (const f of slides.slice(0, 40)) {
    const xml = await read(f);
    const paras = xml.split("</a:p>").map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("").trim()).filter(Boolean);
    const text = paras.join(" · ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
    outline.push(text.slice(0, 400) || "(no text: picture or chart only)");
  }
  if (!outline.length && !Object.keys(colors).length) throw new Error("that PowerPoint has no slides or theme to follow");
  return { colors, fonts: { heading: font("majorFont"), body: font("minorFont") }, wide, outline };
}

export async function getTemplate(store: Store, venture: string): Promise<DeckTemplate | null> {
  return store.settings.get<DeckTemplate | null>(templateKey(venture), null);
}

export async function setTemplate(store: Store, venture: string, name: string, buf: Buffer): Promise<DeckTemplate> {
  const parsed = await parseTemplate(buf);
  const t: DeckTemplate = { ...parsed, fileId: await saveFile(buf, "pptx"), name: name.slice(0, 120), at: new Date().toISOString() };
  await store.settings.set(templateKey(venture), t);
  return t;
}

export async function clearTemplate(store: Store, venture: string) { await store.settings.set(templateKey(venture), null); }

export function templateText(t: DeckTemplate | null): string {
  if (!t) return "No template uploaded yet. Use a clean layout: a cover, the headline numbers, then one slide per topic, and next steps last.";
  return [`Phil's template "${t.name}" (uploaded ${t.at.slice(0, 10)}). Follow its slide order and section names; HQ applies its colours and fonts. Its slides, in order:`, ...t.outline.map((o, i) => `${i + 1}. ${o}`)].join("\n");
}

export async function listDecks(store: Store, venture?: string): Promise<Deck[]> {
  const all = await store.settings.get<Deck[]>(DECKS_KEY, []);
  return (venture ? all.filter((d) => d.venture === venture) : all).slice().reverse();
}

/** Build and keep a deck. */
export async function makeDeck(store: Store, spec: DeckSpec, by: { agentId: string; venture: string }): Promise<Deck> {
  const tpl = await getTemplate(store, by.venture);
  const fileId = await saveFile(await renderDeck(spec, tpl ?? undefined), "pptx");
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const name = `${spec.title.replace(/[^\w\s.-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "Deck"} ${day}.pptx`;
  const deck: Deck = { id: randomUUID(), fileId, name, title: spec.title, agentId: by.agentId, venture: by.venture, at: new Date().toISOString(), slides: spec.slides.length + 1 };
  const all = await store.settings.get<Deck[]>(DECKS_KEY, []);
  await store.settings.set(DECKS_KEY, [...all, deck].slice(-60));
  return deck;
}

export async function deckFile(store: Store, id: string): Promise<{ name: string; mime: string; data: Buffer } | undefined> {
  const d = (await store.settings.get<Deck[]>(DECKS_KEY, [])).find((x) => x.id === id || x.fileId === id);
  const f = d ? await loadFile(d.fileId) : undefined;
  return d && f ? { name: d.name, ...f } : undefined;
}
