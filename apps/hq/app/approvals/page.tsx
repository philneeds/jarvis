"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, post, fmtTime } from "@/lib/api";
import type { Approval } from "@/lib/types";

const KIND: Record<string, string> = { send: "var(--red)", post: "var(--sky, #5CC8F5)", money: "var(--gold)", strategy: "#FF6EC7", config: "var(--accent)", record: "var(--green)", other: "var(--muted)" };

export default function ApprovalsPage() {
  const { state, pending, setPending } = useLive();
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const [decided, setDecided] = useState<Approval[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { if (tab === "decided") api<{ approvals: Approval[] }>("/api/approvals").then((r) => setDecided(r.approvals.filter((a) => a.status !== "pending"))).catch(() => undefined); }, [tab, pending.length]);

  const decide = async (a: Approval, d: "approve" | "reject" | "edit") => {
    setBusy(a.id);
    try {
      await post(`/api/approvals/${a.id}/${d}`, { note: note || undefined, body: d === "edit" ? draft : undefined });
      setPending((p) => p.filter((x) => x.id !== a.id));
      setEditing(null); setNote("");
    } finally { setBusy(null); }
  };
  const agentName = (id: string) => state?.agents.find((x) => x.id === id)?.name ?? id;
  const venture = (id: string) => state?.ventures[state.agents.find((x) => x.id === id)?.venture ?? "root"];
  const list = tab === "pending" ? pending : decided;

  return (
    <Shell>
      <div className="max-w-3xl w-full mx-auto p-4 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--amber)" }}>APPROVALS</h1>
          <span className="text-[12px]" style={{ color: "var(--muted)" }}>{pending.length} waiting</span>
          <div className="tabs ml-auto" style={{ width: 200 }}>
            <button aria-pressed={tab === "pending"} onClick={() => setTab("pending")} style={tab === "pending" ? { borderColor: "var(--accent)" } : undefined}>Waiting</button>
            <button aria-pressed={tab === "decided"} onClick={() => setTab("decided")} style={tab === "decided" ? { borderColor: "var(--accent)" } : undefined}>Decided</button>
          </div>
        </div>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Every send, post, money move, record change and new trading strategy lands here. Nothing goes out until you say so. Mayne&apos;s hard limits apply even after approval.</p>
        {list.length === 0 && <div className="card text-center py-10" style={{ color: "var(--muted)" }}>{tab === "pending" ? "Nothing waiting for you." : "No decisions yet."}</div>}
        {list.map((a) => {
          const v = venture(a.agentId);
          const facts = a.payload ? Object.entries(a.payload).filter(([, val]) => ["string", "number", "boolean"].includes(typeof val)).slice(0, 6) : [];
          return (
            <article key={a.id} className="card flex flex-col gap-3" style={{ borderColor: `color-mix(in srgb, ${v?.color ?? "var(--accent)"} 60%, transparent)`, boxShadow: a.status === "pending" ? `0 0 24px color-mix(in srgb, ${v?.color ?? "var(--accent)"} 18%, transparent)` : undefined }}>
              <div className="flex flex-wrap items-center gap-2 text-[11px] tracking-[0.16em] uppercase">
                <span style={{ color: v?.color }}>{v?.short} · {agentName(a.agentId)}</span>
                <span className="px-1.5 border" style={{ color: KIND[a.kind], borderColor: KIND[a.kind] }}>{a.kind}</span>
                <span className="ml-auto" style={{ color: "var(--dim)", letterSpacing: 0 }}>{fmtTime(a.at)}</span>
              </div>
              <h2 className="display font-bold text-2xl leading-tight m-0" style={{ color: "var(--ink-bright)" }}>{a.title}</h2>
              {editing === a.id ? <textarea className="input h-32 py-2" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit what will happen" /> : <p className="m-0 text-[13px] whitespace-pre-wrap leading-relaxed">{a.body}</p>}
              {facts.length > 0 && <div className="grid grid-cols-2 gap-2">{facts.map(([k, val]) => <div key={k} className="border p-2 flex flex-col gap-0.5" style={{ borderColor: "rgba(239,230,218,0.14)" }}><span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{k}</span><span className="display text-lg">{String(val)}</span></div>)}</div>}
              {a.kind === "strategy" && <div className="border p-2 text-[12px]" style={{ borderColor: "rgba(242,193,78,0.4)" }}><span className="label" style={{ color: "var(--gold)" }}>Mayne&apos;s hard limits</span><br />Max position, max daily loss and auto-stop apply after approval. Set them in agent settings (Phase 2).</div>}
              {a.status === "pending" ? (
                <>
                  <input className="input h-9" placeholder="Note (optional)" aria-label="Note" value={busy === a.id ? note : note} onChange={(e) => setNote(e.target.value)} />
                  <div className="grid grid-cols-3 gap-2">
                    <button className="btn btn-danger" disabled={busy === a.id} onClick={() => decide(a, "reject")}>Reject</button>
                    {editing === a.id ? <button className="btn btn-primary" disabled={busy === a.id} onClick={() => decide(a, "edit")}>Approve edit</button> : <button className="btn" disabled={busy === a.id} onClick={() => { setEditing(a.id); setDraft(a.body); }}>Edit</button>}
                    <button className="btn btn-primary" disabled={busy === a.id || editing === a.id} onClick={() => decide(a, "approve")}>Approve</button>
                  </div>
                </>
              ) : (
                <p className="m-0 text-[11px] tracking-[0.14em] uppercase" style={{ color: a.status === "rejected" ? "var(--red)" : "var(--green)" }}>{a.status}{a.decidedAt ? ` · ${fmtTime(a.decidedAt)}` : ""}{a.note ? ` · ${a.note}` : ""}</p>
              )}
            </article>
          );
        })}
      </div>
    </Shell>
  );
}
