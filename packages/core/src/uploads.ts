import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Images Phil sends (a screenshot in Command, a photo on Telegram), kept on the server's disk so agents that can see
 * (the Claude ones) get the picture itself. JARVIS_UPLOAD_DIR picks the folder; ids are opaque and checked before
 * any file is touched.
 */
export interface ImageInput { mime: string; data: string /* base64 */ }

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MIME: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
/** Claude takes images up to 5 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ID = /^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

const dir = () => process.env.JARVIS_UPLOAD_DIR || path.join("data", "uploads");

export function imageMimeOk(mime: string): boolean { return mime in EXT; }

export async function saveImage(buf: Buffer, mime: string, maxBytes = MAX_IMAGE_BYTES): Promise<string> {
  const m = mime.split(";")[0]!.trim().toLowerCase();
  if (!imageMimeOk(m)) throw new Error("only JPEG, PNG, WebP or GIF images");
  if (!buf.length) throw new Error("empty image");
  if (buf.length > maxBytes) throw new Error(`image is over ${Math.round(maxBytes / 1048576)} MB`);
  const id = `${randomUUID()}.${EXT[m]}`;
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(path.join(dir(), id), buf);
  return id;
}

export async function loadImage(id: string): Promise<{ mime: string; data: Buffer } | undefined> {
  if (!ID.test(id)) return undefined;
  try { return { mime: MIME[id.split(".").pop()!]!, data: await fs.readFile(path.join(dir(), id)) }; }
  catch { return undefined; }
}

export async function imageExists(id: string): Promise<boolean> { return !!(await loadImage(id)); }

/** Other files: sales data Phil uploads, presentation templates, and the decks agents make. */
export const FILE_MIME = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;
export type FileExt = keyof typeof FILE_MIME;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_ID = /^[0-9a-f-]{36}\.(pptx|xlsx|csv|txt|pdf|docx)$/;

export async function saveFile(buf: Buffer, ext: FileExt): Promise<string> {
  if (!buf.length) throw new Error("empty file");
  if (buf.length > MAX_FILE_BYTES) throw new Error("file is over 20 MB");
  const id = `${randomUUID()}.${ext}`;
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(path.join(dir(), id), buf);
  return id;
}

export async function loadFile(id: string): Promise<{ mime: string; data: Buffer } | undefined> {
  if (!FILE_ID.test(id)) return undefined;
  try { return { mime: FILE_MIME[id.split(".").pop() as FileExt], data: await fs.readFile(path.join(dir(), id)) }; }
  catch { return undefined; }
}

export async function removeFile(id: string): Promise<void> {
  if (FILE_ID.test(id) || ID.test(id)) await fs.rm(path.join(dir(), id), { force: true });
}

/** The images as model input, skipping any that are gone. */
export async function imageInputs(ids: string[] = []): Promise<ImageInput[]> {
  const out: ImageInput[] = [];
  for (const id of ids.slice(0, 4)) { const f = await loadImage(id); if (f) out.push({ mime: f.mime, data: f.data.toString("base64") }); }
  return out;
}
