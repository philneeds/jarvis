"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, timeAgo } from "@/lib/api";

type DataFile = { id: string; name: string; at: string; kind: "table" | "image"; rows?: number; note?: string };
type Deck = { id: string; name: string; title: string; at: string; slides: number };
type Tpl = { name: string; at: string; slides: number; fileId: string } | null;

/**
 * The weekly deck for a venture (ProEdge: Stevon builds Tuesday's sales-meeting deck on Monday nights): upload the
 * week's sales data and the template, make the deck now, download past decks.
 */
export function DeckCard({ venture, routineId, agentName, when }: { venture: string; routineId: string; agentName: string; when: string }) {
  const [files, setFiles] = useState<DataFile[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [tpl, setTpl] = useState<Tpl>(null);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dataInput = useRef<HTMLInputElement>(null);
  const tplInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api<{ files: DataFile[]; decks: Deck[]; template: Tpl }>(`/api/data/${venture}`).then((r) => { setFiles(r.files); setDecks(r.decks); setTpl(r.template); }).catch((e) => setMsg((e as Error).message)), [venture]);
  useEffect(() => { void load(); }, [load]);
  // A deck made in the background shows up without a reload.
  useEffect(() => { if (!busy) return; const t = setInterval(() => void load(), 5000); const stop = setTimeout(() => setBusy(false), 180_000); return () => { clearInterval(t); clearTimeout(stop); }; }, [busy, load]);
  useEffect(() => { if (busy && decks[0] && Date.now() - Date.parse(decks[0].at) < 180_000) { setBusy(false); setMsg(`Deck ready: ${decks[0].title}.`); } }, [decks, busy]);

  const upload = async (list: FileList | null, kind: "files" | "template") => {
    if (!list?.length) return;
    setMsg(undefined);
    for (const f of Array.from(list)) {
      try {
        await api(`/api/data/${venture}/${kind}?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f, headers: { "content-type": f.type || "application/octet-stream" } });
        setMsg(kind === "template" ? `Template saved: ${f.name}.` : `Saved ${f.name}.`);
      } catch (e) { setMsg(`${f.name}: ${(e as Error).message}`); }
    }
    void load();
  };

  const week = files.filter((f) => Date.now() - Date.parse(f.at) < 8 * 86_400_000);
  const older = files.length - week.length;

  return (
    <section className="card flex flex-col gap-3" aria-label="Weekly deck">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="label">Weekly deck</span>
        <span className="text-[11px]" style={{ color: "var(--muted)" }}>{agentName} builds it {when}</span>
        <button className="btn btn-sm btn-primary ml-auto" disabled={busy || !week.length} title={week.length ? undefined : "Upload this week's sales data first"} onClick={async () => {
          setMsg(undefined);
          try { await api(`/api/schedules/${routineId}/run`, { method: "POST" }); setBusy(true); setMsg(`${agentName} is building it. It lands in chat and on Telegram in a minute or two.`); } catch (e) { setMsg((e as Error).message); }
        }}>{busy ? "Building…" : "Make the deck now"}</button>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px]" style={{ color: "var(--ink-strong)" }}>This week's sales data</span>
          <button className="btn btn-sm ml-auto" onClick={() => dataInput.current?.click()}>Upload</button>
          <input ref={dataInput} type="file" multiple hidden accept=".csv,.tsv,.txt,.xlsx,image/png,image/jpeg,image/webp" onChange={(e) => { void upload(e.target.files, "files"); e.target.value = ""; }} />
        </div>
        {week.length ? week.map((f) => (
          <div key={f.id} className="flex items-center gap-2 text-[12px]">
            <span className="truncate" style={{ color: "var(--ink)" }}>{f.name}</span>
            <span className="shrink-0" style={{ color: "var(--muted)" }}>{f.kind === "image" ? "screenshot" : `${f.rows ?? 0} rows`} · {timeAgo(f.at)}</span>
            <button className="btn btn-sm ml-auto shrink-0" aria-label={`Remove ${f.name}`} onClick={async () => { await api(`/api/data/${venture}/files/${f.id}`, { method: "DELETE" }).catch(() => undefined); void load(); }}>Remove</button>
          </div>
        )) : <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Nothing yet. Excel, CSV or screenshots; or send the spreadsheet to Jarvis on Telegram.</p>}
        {older > 0 && <p className="m-0 text-[11px]" style={{ color: "var(--dim)" }}>{older} older file{older > 1 ? "s" : ""} kept for week-over-week comparisons.</p>}
      </div>

      <div className="flex items-center gap-2 text-[12px]">
        <span style={{ color: "var(--ink-strong)" }}>Template</span>
        <span className="min-w-0" style={{ color: "var(--muted)" }}>{tpl ? <>{tpl.name} · {tpl.slides} slides · <a href={`/api/files/${tpl.fileId}`} style={{ color: "var(--accent)" }}>download</a></> : "none yet; decks use a clean default"}</span>
        <button className="btn btn-sm ml-auto shrink-0" onClick={() => tplInput.current?.click()}>{tpl ? "Replace" : "Upload .pptx"}</button>
        <input ref={tplInput} type="file" hidden accept=".pptx" onChange={(e) => { void upload(e.target.files, "template"); e.target.value = ""; }} />
      </div>

      {decks.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[12px]" style={{ color: "var(--ink-strong)" }}>Decks</span>
          {decks.slice(0, 6).map((d) => (
            <a key={d.id} href={`/api/files/${d.id}`} className="flex items-center gap-2 text-[12px] no-underline">
              <span className="truncate" style={{ color: "var(--accent)" }}>{d.name}</span>
              <span className="ml-auto shrink-0" style={{ color: "var(--muted)" }}>{d.slides} slides · {timeAgo(d.at)}</span>
            </a>
          ))}
        </div>
      )}
      {msg && <p className="m-0 text-[12px]" style={{ color: "var(--amber)" }}>{msg}</p>}
    </section>
  );
}
