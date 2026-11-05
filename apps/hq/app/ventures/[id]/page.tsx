"use client";

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Sparkline, fmtMetric } from "@/components/Sparkline";
import { MayneLimits } from "@/components/MayneLimits";
import { useLive } from "@/lib/live";
import { useUndo } from "@/lib/undo";
import { api, fmtTime, timeAgo } from "@/lib/api";
import { meaningful } from "@/lib/activity";
import type { Venture, AgentLive, MetricDef, RecordKindDef, Approval, ActivityEntry } from "@/lib/types";

interface Dash {
  venture: Venture; blurb: string; agents: AgentLive[];
  metrics: (MetricDef & { series: { at: string; value: number }[]; latest?: number; latestId?: string; at?: string; delta?: number })[];
  records: (RecordKindDef & { items: { id: string; title: string; status: string; fields: Record<string, unknown>; source?: string; updatedAt: string }[] })[];
  pending: Approval[]; activity: ActivityEntry[];
}

const ST: Record<string, string> = { working: "var(--st-working)", waiting: "var(--st-needs)", idle: "var(--st-idle)", error: "var(--st-error)", paused: "var(--st-paused)" };

export default function VenturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { ventureTick, state } = useLive();
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState<string>();
  const [metricInput, setMetricInput] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null); // record id or "new:<kind>"
  const [draft, setDraft] = useState<{ kind: string; id?: string; title: string; status: string; fields: Record<string, string> }>({ kind: "", title: "", status: "", fields: {} });
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState<{ key: string; value: string } | null>(null); // correcting a metric's latest reading
  const showUndo = useUndo();

  const load = () => api<Dash>(`/api/ventures/${id}`).then((r) => { setD(r); setErr(undefined); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, [id, ventureTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const addMetric = async (e: FormEvent, key: string) => {
    e.preventDefault();
    const v = Number(metricInput[key]);
    if (!metricInput[key] || Number.isNaN(v)) return;
    setBusy(true);
    try { await api(`/api/ventures/${id}/metrics`, { method: "POST", body: JSON.stringify({ key, value: v }) }); setMetricInput({ ...metricInput, [key]: "" }); await load(); } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const startNew = (k: RecordKindDef) => { setEditing(`new:${k.kind}`); setDraft({ kind: k.kind, title: "", status: k.statuses[0]!, fields: {} }); };
  const startEdit = (k: RecordKindDef, r: Dash["records"][number]["items"][number]) => { setEditing(r.id); setDraft({ kind: k.kind, id: r.id, title: r.title, status: r.status, fields: Object.fromEntries(k.fields.map((f) => [f.key, r.fields[f.key] === undefined ? "" : String(r.fields[f.key])])) }); };
  const saveRecord = async () => {
    if (!draft.title.trim()) return;
    setBusy(true);
    try {
      const kindDef = d?.records.find((k) => k.kind === draft.kind);
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(draft.fields)) { if (v === "") continue; const f = kindDef?.fields.find((x) => x.key === k); fields[k] = f?.type === "number" || f?.type === "money" ? Number(v) : v; }
      await api(`/api/ventures/${id}/records`, { method: "PUT", body: JSON.stringify({ kind: draft.kind, id: draft.id, title: draft.title.trim(), status: draft.status, fields }) });
      setEditing(null); await load();
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const setStatus = async (r: { id: string; title: string }, kind: string, status: string) => { await api(`/api/ventures/${id}/records`, { method: "PUT", body: JSON.stringify({ kind, id: r.id, title: r.title, status }) }); await load(); };
  const remove = async (r: { id: string; title: string }) => {
    try {
      const res = await api<{ undoId: string }>(`/api/ventures/${id}/records/${r.id}`, { method: "DELETE" });
      await load();
      showUndo(`Removed “${r.title}”`, res.undoId, () => void load());
    } catch (e2) { setErr((e2 as Error).message); }
  };
  const fixMetric = async (e: FormEvent, m: Dash["metrics"][number]) => {
    e.preventDefault();
    if (!fixing || !m.latestId) return;
    const v = Number(fixing.value);
    if (fixing.value.trim() === "" || !Number.isFinite(v)) return;
    setBusy(true);
    try { await api(`/api/ventures/${id}/metrics/${m.latestId}`, { method: "PUT", body: JSON.stringify({ value: v }) }); setFixing(null); await load(); } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const deleteReading = async (m: Dash["metrics"][number]) => {
    if (!m.latestId) return;
    setBusy(true);
    try {
      const res = await api<{ undoId: string }>(`/api/ventures/${id}/metrics/${m.latestId}`, { method: "DELETE" });
      setFixing(null); await load();
      showUndo(`Deleted ${m.label} reading ${fmtMetric(m.latest, m.unit)}`, res.undoId, () => void load());
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };

  if (!d) return <Shell><div className="p-6" style={{ color: err ? "var(--red)" : "var(--muted)" }}>{err ?? "Loading…"}</div></Shell>;
  const c = d.venture.color;
  const lead = d.agents.find((a) => a.id === d.venture.lead) ?? d.agents[0];
  const recent = d.activity.filter(meaningful);
  const fmtField = (v: unknown, type?: string) => v === undefined || v === "" ? "" : type === "money" ? fmtMetric(Number(v), "$") : String(v);

  return (
    <Shell>
      <div className="max-w-5xl w-full mx-auto p-4 flex flex-col gap-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Link href="/ventures" className="text-[11px] tracking-[0.14em] uppercase">‹ Ventures</Link>
          <h1 className="display font-bold text-3xl m-0 tracking-[0.06em]" style={{ color: c, textShadow: `0 0 12px ${c}66` }}>{d.venture.label}</h1>
          <span className="text-[12px]" style={{ color: "var(--muted)" }}>{d.blurb}</span>
        </div>
        {err && <p className="m-0 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}

        {d.metrics.length > 0 && (
          <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-4" aria-label="Metrics">
            {d.metrics.map((m) => {
              const up = m.delta !== undefined && m.delta > 0, down = m.delta !== undefined && m.delta < 0;
              const goodDir = m.good === "down" ? down : up;
              const deltaColor = m.delta === undefined || m.delta === 0 ? "var(--muted)" : goodDir ? "var(--green)" : "var(--red)";
              return (
                <div key={m.key} className="card flex flex-col gap-2" style={{ borderColor: `color-mix(in srgb, ${c} 40%, transparent)` }}>
                  <span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{m.label}</span>
                  <div className="flex items-baseline gap-2"><span className="display text-2xl" style={{ color: "var(--ink-bright)" }}>{fmtMetric(m.latest, m.unit)}</span>{m.delta !== undefined && <span className="text-[11px]" style={{ color: deltaColor }}>{m.delta > 0 ? "▲" : m.delta < 0 ? "▼" : "•"} {fmtMetric(Math.abs(m.delta), m.unit)}</span>}</div>
                  <Sparkline points={m.series} color={c} width={200} height={40} />
                  {fixing?.key === m.key && m.latestId ? (
                    <form className="flex flex-col gap-1.5" onSubmit={(e) => fixMetric(e, m)} onKeyDown={(e) => { if (e.key === "Escape") setFixing(null); }} aria-label={`Fix the latest ${m.label} reading`}>
                      <span className="text-[10px]" style={{ color: "var(--muted)" }}>Latest reading{m.at ? `, ${timeAgo(m.at)}` : ""}</span>
                      <div className="flex gap-1">
                        <input className="input h-8 flex-1 text-[12px]" type="number" step="any" aria-label={`Corrected ${m.label} value`} value={fixing.value} onChange={(e) => setFixing({ key: m.key, value: e.target.value })} autoFocus />
                        <button className="btn btn-sm h-8 btn-primary" disabled={busy || fixing.value.trim() === "" || !Number.isFinite(Number(fixing.value))}>Save</button>
                      </div>
                      <div className="flex gap-1 justify-between">
                        <button type="button" className="btn btn-sm h-8 btn-danger" disabled={busy} onClick={() => deleteReading(m)}>Delete reading</button>
                        <button type="button" className="btn btn-sm h-8" onClick={() => setFixing(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: "var(--dim)" }}>
                      <span className="flex items-center gap-1 min-w-0">{m.at ? timeAgo(m.at) : "no readings"}{m.latestId && <button type="button" className="msg-act" onClick={() => setFixing({ key: m.key, value: String(m.latest ?? "") })} aria-label={`Fix the latest ${m.label} reading`}>Fix</button>}</span>
                      <form className="flex gap-1" onSubmit={(e) => addMetric(e, m.key)}>
                        <input className="input h-7 w-20 text-[11px]" type="number" step="any" placeholder="add" aria-label={`New ${m.label} reading`} value={metricInput[m.key] ?? ""} onChange={(e) => setMetricInput({ ...metricInput, [m.key]: e.target.value })} />
                        <button className="btn btn-sm h-7" disabled={busy || !metricInput[m.key]} aria-label={`Add ${m.label} reading`}>+</button>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {id === "money" && <MayneLimits />}

        {d.records.map((k) => (
          <section key={k.kind} className="card flex flex-col gap-3" aria-label={k.label}>
            <div className="flex items-center gap-3"><span className="label" style={{ color: c }}>{k.label} · {k.items.length}</span><button className="btn btn-sm ml-auto" onClick={() => startNew(k)}>Add</button></div>
            {editing === `new:${k.kind}` || (editing && k.items.some((r) => r.id === editing)) ? (
              <div className="flex flex-col gap-2 p-3 border" style={{ borderColor: "var(--line)" }}>
                <div className="flex flex-wrap gap-2">
                  <input className="input h-9 flex-1 min-w-48" placeholder="Title" aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus />
                  <select className="input h-9 w-44" aria-label="Status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{k.statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>
                </div>
                <div className="flex flex-wrap gap-2">
                  {k.fields.map((f) => <label key={f.key} className="flex flex-col gap-1 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>{f.label}<input className="input h-9 w-40 normal-case tracking-normal" type={f.type === "number" || f.type === "money" ? "number" : f.type === "date" ? "date" : "text"} value={draft.fields[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, fields: { ...draft.fields, [f.key]: e.target.value } })} aria-label={f.label} /></label>)}
                </div>
                <div className="flex gap-2 justify-end"><button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-sm btn-primary" disabled={busy || !draft.title.trim()} onClick={saveRecord}>Save</button></div>
              </div>
            ) : null}
            {k.items.length === 0 && editing !== `new:${k.kind}` && <span className="text-[12px]" style={{ color: "var(--muted)" }}>No {k.label.replace(/\s*\(.*\)$/, "").toLowerCase()} yet. {k.label.includes("(") ? k.label.slice(k.label.indexOf("(") + 1, -1) : "The team"} adds them as they work, or press Add.</span>}
            {k.items.length > 0 && (
              <div className="overflow-x-auto">
                <table className="tbl"><thead><tr><th>Title</th><th>Status</th>{k.fields.map((f) => <th key={f.key}>{f.label}</th>)}<th>Updated</th><th></th></tr></thead>
                  <tbody>{k.items.map((r) => (
                    <tr key={r.id}>
                      <td><button className="bg-transparent border-0 p-0 cursor-pointer text-left" style={{ color: "var(--ink-bright)" }} onClick={() => startEdit(k, r)}>{r.title}</button></td>
                      <td><select className="input h-8 text-[11px] w-36" aria-label={`Status of ${r.title}`} value={r.status} onChange={(e) => setStatus(r, k.kind, e.target.value)}>{k.statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select></td>
                      {k.fields.map((f) => <td key={f.key} className="whitespace-nowrap">{fmtField(r.fields[f.key], f.type)}</td>)}
                      <td className="whitespace-nowrap" style={{ color: "var(--muted)" }}>{timeAgo(r.updatedAt)}{r.source ? ` · ${r.source}` : ""}</td>
                      <td><button className="btn btn-sm btn-danger" onClick={() => remove(r)} aria-label={`Remove ${r.title}`}>×</button></td>
                    </tr>
                  ))}</tbody></table>
              </div>
            )}
          </section>
        ))}

        <div className="grid gap-4 md:grid-cols-2">
          <section className="card flex flex-col gap-2" aria-label="Team">
            <span className="label" style={{ color: c }}>Team</span>
            {d.agents.map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-[12px]" style={{ opacity: a.live ? 1 : 0.55 }}>
                <span className="dot" style={{ background: ST[a.status] ?? ST.idle, boxShadow: a.status !== "idle" ? `0 0 8px ${ST[a.status]}` : "none" }} />
                <Link href={`/web?agent=${a.id}`} style={{ color: "var(--ink-strong)" }}>{a.name}</Link>
                <span style={{ color: "var(--muted)" }}>{a.short}{a.venture !== id ? " · helping" : ""}{!a.live ? ` · phase ${a.phase}` : ""}</span>
                <span className="ml-auto whitespace-nowrap" style={{ color: "var(--dim)" }}>{a.lastRunAt ? timeAgo(a.lastRunAt) : ""}</span>
                <Link href={`/command?say=${encodeURIComponent(`@${a.id} `)}`} className="btn btn-sm">Talk</Link>
              </div>
            ))}
          </section>
          <section className="card flex flex-col gap-2" aria-label="Waiting on you">
            <span className="label label-amber">Waiting on you · {d.pending.length}</span>
            {d.pending.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing waiting. When this team wants to send, post or spend, the draft lands here first.</span>}
            {d.pending.map((p) => <Link key={p.id} href="/approvals" className="text-[12px]" style={{ color: "var(--ink-bright)" }}><span style={{ color: "var(--amber)" }}>{p.kind}</span> · {p.title}</Link>)}
            <span className="label mt-3" style={{ color: c }}>Recent</span>
            {recent.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing yet. Hand-offs, approvals and board changes show here{lead ? <>; <Link href={`/command?say=${encodeURIComponent(`@${lead.id} `)}`}>give {lead.name} a task</Link></> : ""}.</span>}
            {recent.slice(0, 10).map((e) => <div key={e.id} className="text-[12px] flex gap-2"><span className="whitespace-nowrap" style={{ color: "var(--dim)" }}>{fmtTime(e.at)}</span><span>{e.summary}</span></div>)}
            {state && <Link href={`/activity?agent=`} className="text-[11px] tracking-[0.14em] uppercase" style={{ color: c }}>Full log ›</Link>}
          </section>
        </div>
      </div>
    </Shell>
  );
}
