"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, post, put, fmtTime, timeAgo } from "@/lib/api";
import type { AttentionItem } from "@/lib/types";

/** Things Phil has to do himself. Raised by agents (or by Phil), they wait here until ticked off. */
export default function AttentionPage() {
  const { state, attention } = useLive();
  const [tab, setTab] = useState<"open" | "done">("open");
  const [done, setDone] = useState<AttentionItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", why: "", due: "" });
  const [err, setErr] = useState<string>();

  useEffect(() => { if (tab === "done") api<{ items: AttentionItem[] }>("/api/attention?all=1").then((r) => setDone(r.items.filter((i) => i.status === "done").sort((a, b) => ((a.doneAt ?? "") < (b.doneAt ?? "") ? 1 : -1)))).catch(() => undefined); }, [tab, attention.length]);

  const act = async (i: AttentionItem, change: "done" | "snoozed" | "reopened") => { setBusy(i.id); try { await post(`/api/attention/${i.id}/${change}`, change === "snoozed" ? { days: 3 } : undefined); } finally { setBusy(null); } };
  const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const startEdit = (i: AttentionItem) => { setEditing(i.id); setErr(undefined); setDraft({ title: i.title, why: i.why, due: isDate(i.due) ? i.due! : "" }); };
  const saveEdit = async (i: AttentionItem) => {
    const patch: { title?: string; why?: string; due?: string | null } = {};
    if (draft.title.trim() !== i.title) patch.title = draft.title.trim();
    if (draft.why.trim() !== i.why) patch.why = draft.why.trim();
    if (draft.due !== (isDate(i.due) ? i.due : "")) patch.due = draft.due || null;
    if (!Object.keys(patch).length) { setEditing(null); return; }
    setBusy(i.id); setErr(undefined);
    try {
      const r = await put<{ item: AttentionItem }>(`/api/attention/${i.id}`, patch);
      setDone((d) => d.map((x) => (x.id === r.item.id ? r.item : x)));
      setEditing(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const add = async (e: FormEvent) => { e.preventDefault(); if (!title.trim()) return; await post("/api/attention", { title: title.trim(), why: why.trim() }); setTitle(""); setWhy(""); };

  const who = (id: string) => state?.agents.find((a) => a.id === id)?.name ?? (id === "jarvis" ? "Phil" : id);
  const color = (id: string) => state?.ventures[state.agents.find((a) => a.id === id)?.venture ?? "root"]?.color ?? "var(--amber)";
  const open = attention.filter((i) => i.status === "open").sort((a, b) => (a.at < b.at ? -1 : 1)); // oldest first: the ones most likely to slip
  const snoozed = attention.filter((i) => i.status === "snoozed");
  const list = tab === "open" ? [...open, ...snoozed] : done;

  return (
    <Shell>
      <div className="max-w-3xl w-full mx-auto p-4 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--amber)" }}>NEEDS YOU</h1>
          <span className="text-[12px]" style={{ color: "var(--muted)" }}>{open.length} open{snoozed.length ? ` · ${snoozed.length} snoozed` : ""}</span>
          <div className="tabs ml-auto" style={{ width: 200 }}>
            <button aria-pressed={tab === "open"} onClick={() => setTab("open")} style={tab === "open" ? { borderColor: "var(--accent)" } : undefined}>Waiting</button>
            <button aria-pressed={tab === "done"} onClick={() => setTab("done")} style={tab === "done" ? { borderColor: "var(--accent)" } : undefined}>Done</button>
          </div>
        </div>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Things only you can do. Agents put them here instead of burying them in a reply; they stay until you tick them off. Oldest first. Jarvis reads the open ones in the morning brief.</p>

        <form onSubmit={add} className="card flex flex-wrap gap-2 items-end">
          <label className="flex flex-col gap-1 flex-1 min-w-48 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>Add one yourself<input className="input h-9" placeholder="What needs doing" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="flex flex-col gap-1 flex-1 min-w-48 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>Why / details<input className="input h-9" value={why} onChange={(e) => setWhy(e.target.value)} /></label>
          <button className="btn btn-sm btn-primary h-9" disabled={!title.trim()}>Add</button>
        </form>

        {list.length === 0 && <div className="card text-center py-10" style={{ color: "var(--muted)" }}>{tab === "open" ? "Nothing waiting on you. When an agent needs a call from you, it lands here." : "Nothing done yet. Items you tick off are kept here."}</div>}
        {list.map((i) => {
          const age = Math.floor((Date.now() - Date.parse(i.at)) / 86400_000);
          return (
            <article key={i.id} className="card flex flex-col gap-2" style={{ borderColor: `color-mix(in srgb, ${i.status === "snoozed" ? "var(--dim)" : age >= 3 ? "var(--red)" : "var(--amber)"} 60%, transparent)`, opacity: i.status === "snoozed" ? 0.7 : 1 }}>
              <div className="flex flex-wrap items-center gap-2 text-[11px] tracking-[0.16em] uppercase">
                <span style={{ color: color(i.agentId) }}>{who(i.agentId)}</span>
                <span style={{ color: age >= 3 && i.status === "open" ? "var(--red)" : "var(--muted)", letterSpacing: 0 }}>{age === 0 ? "today" : `${age}d waiting`}{i.due ? ` · due ${i.due}` : ""}{i.status === "snoozed" && i.snoozedUntil ? ` · snoozed until ${fmtTime(i.snoozedUntil)}` : ""}{i.status === "done" && i.doneAt ? ` · done ${timeAgo(i.doneAt)}` : ""}</span>
                <span className="ml-auto" style={{ color: "var(--dim)", letterSpacing: 0 }}>{fmtTime(i.at)}</span>
              </div>
              {editing === i.id ? (
                <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void saveEdit(i); }} onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}>
                  <label className="flex flex-col gap-1 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>Title<input className="input h-10 normal-case tracking-normal text-[14px]" value={draft.title} maxLength={160} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus /></label>
                  <label className="flex flex-col gap-1 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>Why / details<textarea className="input py-2 normal-case tracking-normal text-[13px]" style={{ height: 88 }} value={draft.why} maxLength={600} onChange={(e) => setDraft({ ...draft, why: e.target.value })} /></label>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>Due{i.due && !isDate(i.due) ? ` (was “${i.due}”)` : ""}<input className="input h-9 w-44 normal-case tracking-normal" type="date" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} /></label>
                    {draft.due && <button type="button" className="btn btn-sm h-9" onClick={() => setDraft({ ...draft, due: "" })}>No due date</button>}
                    <span className="ml-auto flex gap-2">
                      <button type="button" className="btn btn-sm h-9" onClick={() => setEditing(null)}>Cancel</button>
                      <button className="btn btn-sm btn-primary h-9" disabled={busy === i.id || !draft.title.trim()}>Save</button>
                    </span>
                  </div>
                  {err && <p className="m-0 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
                </form>
              ) : (
                <>
                  <h2 className="display font-bold text-xl leading-tight m-0" style={{ color: "var(--ink-bright)" }}>{i.title}</h2>
                  {i.why && <p className="m-0 text-[13px] whitespace-pre-wrap leading-relaxed">{i.why}</p>}
                </>
              )}
              {editing !== i.id && <div className="flex flex-wrap gap-2 justify-end">
                <button className="btn btn-sm" disabled={busy === i.id} onClick={() => startEdit(i)} aria-label={`Edit ${i.title}`}>Edit</button>
                {i.status === "done" ? <button className="btn btn-sm" disabled={busy === i.id} onClick={() => act(i, "reopened")}>Reopen</button> : (
                  <>
                    {i.status === "open" && <button className="btn btn-sm" disabled={busy === i.id} onClick={() => act(i, "snoozed")}>Snooze 3 days</button>}
                    {i.status === "snoozed" && <button className="btn btn-sm" disabled={busy === i.id} onClick={() => act(i, "reopened")}>Wake</button>}
                    <button className="btn btn-sm btn-primary" disabled={busy === i.id} onClick={() => act(i, "done")}>Done</button>
                  </>
                )}
              </div>}
            </article>
          );
        })}
      </div>
    </Shell>
  );
}
