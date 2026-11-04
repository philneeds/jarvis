"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, post, fmtTime, timeAgo } from "@/lib/api";
import type { AttentionItem } from "@/lib/types";

/** Things Phil has to do himself. Raised by agents (or by Phil), they wait here until ticked off. */
export default function AttentionPage() {
  const { state, attention } = useLive();
  const [tab, setTab] = useState<"open" | "done">("open");
  const [done, setDone] = useState<AttentionItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");

  useEffect(() => { if (tab === "done") api<{ items: AttentionItem[] }>("/api/attention?all=1").then((r) => setDone(r.items.filter((i) => i.status === "done").sort((a, b) => ((a.doneAt ?? "") < (b.doneAt ?? "") ? 1 : -1)))).catch(() => undefined); }, [tab, attention.length]);

  const act = async (i: AttentionItem, change: "done" | "snoozed" | "reopened") => { setBusy(i.id); try { await post(`/api/attention/${i.id}/${change}`, change === "snoozed" ? { days: 3 } : undefined); } finally { setBusy(null); } };
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

        {list.length === 0 && <div className="card text-center py-10" style={{ color: "var(--muted)" }}>{tab === "open" ? "Nothing waiting on you." : "Nothing done yet."}</div>}
        {list.map((i) => {
          const age = Math.floor((Date.now() - Date.parse(i.at)) / 86400_000);
          return (
            <article key={i.id} className="card flex flex-col gap-2" style={{ borderColor: `color-mix(in srgb, ${i.status === "snoozed" ? "var(--dim)" : age >= 3 ? "var(--red)" : "var(--amber)"} 60%, transparent)`, opacity: i.status === "snoozed" ? 0.7 : 1 }}>
              <div className="flex flex-wrap items-center gap-2 text-[11px] tracking-[0.16em] uppercase">
                <span style={{ color: color(i.agentId) }}>{who(i.agentId)}</span>
                <span style={{ color: age >= 3 && i.status === "open" ? "var(--red)" : "var(--muted)", letterSpacing: 0 }}>{age === 0 ? "today" : `${age}d waiting`}{i.due ? ` · due ${i.due}` : ""}{i.status === "snoozed" && i.snoozedUntil ? ` · snoozed until ${fmtTime(i.snoozedUntil)}` : ""}{i.status === "done" && i.doneAt ? ` · done ${timeAgo(i.doneAt)}` : ""}</span>
                <span className="ml-auto" style={{ color: "var(--dim)", letterSpacing: 0 }}>{fmtTime(i.at)}</span>
              </div>
              <h2 className="display font-bold text-xl leading-tight m-0" style={{ color: "var(--ink-bright)" }}>{i.title}</h2>
              {i.why && <p className="m-0 text-[13px] whitespace-pre-wrap leading-relaxed">{i.why}</p>}
              <div className="flex gap-2 justify-end">
                {i.status === "done" ? <button className="btn btn-sm" disabled={busy === i.id} onClick={() => act(i, "reopened")}>Reopen</button> : (
                  <>
                    {i.status === "open" && <button className="btn btn-sm" disabled={busy === i.id} onClick={() => act(i, "snoozed")}>Snooze 3 days</button>}
                    {i.status === "snoozed" && <button className="btn btn-sm" disabled={busy === i.id} onClick={() => act(i, "reopened")}>Wake</button>}
                    <button className="btn btn-sm btn-primary" disabled={busy === i.id} onClick={() => act(i, "done")}>Done</button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </Shell>
  );
}
