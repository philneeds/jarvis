"use client";

import { useState } from "react";
import { uploadImage } from "./images";

/**
 * Files Phil attaches to a message, in Command and on the home command line: images go up as images (shrunk first);
 * PDFs, Word, Excel, CSV, PowerPoint and text files are read into text on the server as they upload, so a file HQ
 * can't read is flagged before he sends. The ids go with the message.
 */
export const ACCEPT = "image/*,.pdf,.docx,.xlsx,.csv,.tsv,.pptx,.txt,.md,.json,application/pdf";
const MAX_IMAGES = 4, MAX_DOCS = 5;

export type Attached = { key: string; name: string; image: boolean; preview?: string; id?: string; label?: string; failed?: string };

export async function uploadDoc(file: File): Promise<{ id: string; label: string }> {
  const r = await fetch(`/api/docs?name=${encodeURIComponent(file.name)}`, { method: "POST", credentials: "include", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
  const j = (await r.json().catch(() => ({}))) as { doc?: { id: string; type: string; pages?: number; rows?: number; slides?: number }; error?: string };
  if (!r.ok || !j.doc) throw new Error(j.error ?? `upload failed (${r.status})`);
  const d = j.doc;
  const size = d.pages ? `${d.pages} p` : d.slides ? `${d.slides} slides` : d.rows ? `${d.rows} rows` : "";
  return { id: d.id, label: size };
}

export function useAttachments() {
  const [items, setItems] = useState<Attached[]>([]);
  const [error, setError] = useState<string>();
  const add = (files: FileList | File[]) => {
    setError(undefined);
    let imgs = items.filter((a) => a.image).length, docs = items.length - imgs;
    for (const f of [...files]) {
      const image = f.type.startsWith("image/") && f.type !== "image/heic" && f.type !== "image/heif";
      if (image ? imgs >= MAX_IMAGES : docs >= MAX_DOCS) { setError(`Up to ${MAX_IMAGES} images and ${MAX_DOCS} files on one message.`); continue; }
      if (image) imgs++; else docs++;
      const key = Math.random().toString(36).slice(2);
      setItems((a) => [...a, { key, name: f.name || (image ? "image" : "file"), image, preview: image ? URL.createObjectURL(f) : undefined }]);
      const up = image ? uploadImage(f).then((id) => ({ id, label: "" })) : uploadDoc(f);
      up.then(({ id, label }) => setItems((a) => a.map((x) => (x.key === key ? { ...x, id, label } : x))))
        .catch((e) => { const m = (e as Error).message; setError(`${f.name}: ${m}`); setItems((a) => a.map((x) => (x.key === key ? { ...x, failed: m } : x))); });
    }
  };
  const remove = (key: string) => setItems((a) => a.filter((x) => x.key !== key));
  const clear = () => { setItems([]); setError(undefined); };
  const ready = items.filter((a) => a.id);
  return {
    items, error, setError, add, remove, clear,
    uploading: items.some((a) => !a.id && !a.failed),
    images: ready.filter((a) => a.image).map((a) => a.id!),
    docs: ready.filter((a) => !a.image).map((a) => a.id!),
    any: ready.length > 0,
  };
}
export type Attachments = ReturnType<typeof useAttachments>;

export function ClipIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.5 3.5 0 0 1 5 5l-8.6 8.6a2 2 0 0 1-2.8-2.8l7.9-7.9" /></svg>;
}

/** What's waiting to go with the next message: image thumbnails and file chips, each removable. */
export function AttachTray({ att }: { att: Attachments }) {
  if (!att.items.length) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Attached to the next message">
      {att.items.map((a) => (
        <div key={a.key} className="relative" title={a.failed ?? a.name}>
          {a.image ? (
            <img src={a.preview} alt={a.name} className="h-16 w-16 object-cover border" style={{ borderColor: a.failed ? "var(--red)" : "var(--accent-soft)", opacity: a.id ? 1 : 0.5 }} />
          ) : (
            <div className="h-16 max-w-[220px] px-3 flex flex-col justify-center border text-[12px]" style={{ borderColor: a.failed ? "var(--red)" : "var(--accent-soft)", opacity: a.id || a.failed ? 1 : 0.6 }}>
              <span className="truncate">📄 {a.name}</span>
              <span className="text-[11px]" style={{ color: a.failed ? "var(--red)" : "var(--muted)" }}>{a.failed ? "can't read this" : a.id ? `read${a.label ? ` · ${a.label}` : ""}` : "reading…"}</span>
            </div>
          )}
          <button type="button" className="absolute -top-2 -right-2 w-6 h-6 rounded-full text-[12px] border" style={{ background: "var(--panel)", borderColor: "var(--line)" }} aria-label={`Remove ${a.name}`} onClick={() => att.remove(a.key)}>×</button>
        </div>
      ))}
      {att.uploading && <span className="self-center text-[11px]" style={{ color: "var(--muted)" }}>uploading…</span>}
    </div>
  );
}
