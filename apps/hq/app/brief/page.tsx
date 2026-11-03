"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Md } from "@/components/Md";
import { api, post, fmtTime } from "@/lib/api";

interface Brief { at: string; text: string }

export default function BriefPage() {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [history, setHistory] = useState<Brief[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string>();

  const load = () => api<{ brief: Brief | null; history: Brief[] }>("/api/brief").then((r) => { setBrief(r.brief); setHistory(r.history); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);
  const run = async () => { setBusy(true); setErr(undefined); try { await post("/api/brief"); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };

  return (
    <Shell>
      <div className="max-w-3xl w-full mx-auto p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>DAILY BRIEF</h1>
          <span className="text-[12px]" style={{ color: "var(--muted)" }}>{brief ? fmtTime(brief.at) : "none yet"}</span>
          <button className="btn btn-sm btn-primary ml-auto" disabled={busy} onClick={run}>{busy ? "Jarvis is writing…" : "Run now"}</button>
        </div>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Jarvis&apos;s morning rundown: Monica&apos;s day, Munger&apos;s money, Stella&apos;s leads, Mantis&apos;s markets, Doc&apos;s health. Runs on its own every morning (BRIEF_AT); leads that aren&apos;t live yet say so.</p>
        {err && <p className="m-0 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
        {brief ? <article className="card text-[13px] leading-relaxed whitespace-pre-wrap"><Md text={brief.text} /></article> : <div className="card text-center py-10" style={{ color: "var(--muted)" }}>No brief yet. Run one.</div>}
        {history.length > 1 && (
          <section className="flex flex-col gap-2" aria-label="Earlier briefs">
            <span className="label">Earlier</span>
            {history.slice(1).map((b) => (
              <div key={b.at} className="card">
                <button className="bg-transparent border-0 p-0 cursor-pointer text-left w-full flex justify-between" onClick={() => setOpen(open === b.at ? null : b.at)} aria-expanded={open === b.at}><span style={{ color: "var(--ink-strong)" }}>{fmtTime(b.at)}</span><span style={{ color: "var(--muted)" }}>{open === b.at ? "▴" : "▾"}</span></button>
                {open === b.at && <div className="mt-3 text-[13px] leading-relaxed whitespace-pre-wrap"><Md text={b.text} /></div>}
              </div>
            ))}
          </section>
        )}
      </div>
    </Shell>
  );
}
