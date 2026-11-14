"use client";

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Sparkline, fmtMetric } from "@/components/Sparkline";
import { MayneLimits } from "@/components/MayneLimits";
import { useLive } from "@/lib/live";
import { useUndo } from "@/lib/undo";
import { useBase, LEVEL_NAME } from "@/lib/base";
import { api, fmtTime, timeAgo } from "@/lib/api";
import { meaningful } from "@/lib/activity";
import type { Venture, AgentLive, MetricDef, RecordKindDef, Approval, ActivityEntry } from "@/lib/types";

type Item = { id: string; title: string; status: string; fields: Record<string, unknown>; source?: string; createdAt?: string; updatedAt: string };
type Metric = MetricDef & { series: { at: string; value: number }[]; latest?: number; latestId?: string; at?: string; delta?: number };
type Kind = RecordKindDef & { items: Item[]; addedWeek?: number };
interface Dash { venture: Venture; blurb: string; agents: AgentLive[]; metrics: Metric[]; records: Kind[]; pending: Approval[]; activity: ActivityEntry[] }

const ST: Record<string, string> = { working: "var(--st-working)", waiting: "var(--st-needs)", idle: "var(--st-idle)", error: "var(--st-error)", paused: "var(--st-paused)" };
/** Statuses that mean the item is finished one way or another; those rows sit behind "Show closed". */
const CLOSED = new Set(["won", "lost", "done", "dropped", "left", "retired", "exited", "stopped", "posted", "winner", "shipped", "sell"]);
/** Status colours: good outcomes green, bad red, in-flight amber, everything else the venture's own colour. */
const tone = (s: string) => (/^(won|done|shipped|posted|winner|on quota|approved|live|on track)$/.test(s) ? "var(--green)" : /^(lost|dropped|left|blocked|behind|slipping|retired|stopped|sell)$/.test(s) ? "var(--red)" : /^(quoted|contacted|in progress|building|paper|backtest|mantis review|scheduled|entered|running)$/.test(s) ? "var(--amber)" : undefined);

export default function VenturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { ventureTick } = useLive();
  const { base } = useBase();
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const showUndo = useUndo();

  const load = () => api<Dash>(`/api/ventures/${id}`).then((r) => { setD(r); setErr(undefined); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, [id, ventureTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(undefined); try { await fn(); await load(); return true; } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(false); } };

  if (!d) return <Shell><div className="p-6" style={{ color: err ? "var(--red)" : "var(--muted)" }}>{err ?? "Loading…"}</div></Shell>;
  const c = d.venture.color;
  const lead = d.agents.find((a) => a.id === d.venture.lead) ?? d.agents[0];
  const live = d.agents.filter((a) => a.live), working = d.agents.filter((a) => a.status === "working");
  const recent = d.activity.filter(meaningful);
  const lv = base?.levels[id];

  return (
    <Shell>
      <div className="max-w-6xl w-full mx-auto p-4 md:p-6 flex flex-col gap-5">
        {/* Who runs it, how it's doing, and the one button most visits want. */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/" className="text-[11px] tracking-[0.14em] uppercase">‹ Base</Link>
          <div className="flex flex-col min-w-[14rem] flex-1">
            <h1 className="display font-bold text-2xl md:text-3xl m-0 tracking-[0.04em] leading-tight" style={{ color: c }}>{d.venture.label}</h1>
            <span className="text-[12px]" style={{ color: "var(--muted)" }}>
              {lead ? `${lead.name} leads · ` : ""}{live.length} of {d.agents.length} agents live{working.length ? ` · ${working.length} working now` : ""}{lv ? ` · level ${lv.level} ${LEVEL_NAME[lv.level]}` : ""}
            </span>
          </div>
          {lead && lead.live && <Link className="btn btn-sm btn-primary" href={`/command?say=${encodeURIComponent(`@${lead.id} `)}`}>Talk to {lead.name.split(" ")[0]}</Link>}
        </header>
        {err && <p className="m-0 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}

        {d.pending.length > 0 && (
          <section aria-label="Waiting on you" className="flex flex-col gap-2 p-3 border" style={{ borderColor: "var(--amber)", background: "rgba(255,194,102,0.06)" }}>
            <span className="label label-amber">Waiting on you · {d.pending.length}</span>
            {d.pending.map((p) => (
              <Link key={p.id} href="/attention#approve" className="flex items-center gap-3 text-[13px] min-w-0" style={{ color: "var(--ink-bright)" }}>
                <span className="truncate flex-1">{p.title}</span><span className="flex-none text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--amber)" }}>Review ›</span>
              </Link>
            ))}
          </section>
        )}

        {d.metrics.length > 0 && (
          <section className="grid gap-3 grid-cols-2 lg:grid-cols-4" aria-label="Numbers">
            {d.metrics.map((m) => <MetricTile key={m.key} m={m} color={c} busy={busy}
              onAdd={(value) => act(() => api(`/api/ventures/${id}/metrics`, { method: "POST", body: JSON.stringify({ key: m.key, value }) }))}
              onFix={(value) => act(() => api(`/api/ventures/${id}/metrics/${m.latestId}`, { method: "PUT", body: JSON.stringify({ value }) }))}
              onDelete={async () => { const r = await api<{ undoId: string }>(`/api/ventures/${id}/metrics/${m.latestId}`, { method: "DELETE" }).catch((e) => { setErr((e as Error).message); return null; }); if (r) { await load(); showUndo(`Deleted ${m.label} reading ${fmtMetric(m.latest, m.unit)}`, r.undoId, () => void load()); } }} />)}
          </section>
        )}

        {id === "money" && <MayneLimits />}

        {d.records.map((k) => <Board key={k.kind} k={k} color={c} busy={busy}
          onSave={(body) => act(() => api(`/api/ventures/${id}/records`, { method: "PUT", body: JSON.stringify(body) }))}
          onRemove={async (r) => { const res = await api<{ undoId: string }>(`/api/ventures/${id}/records/${r.id}`, { method: "DELETE" }).catch((e) => { setErr((e as Error).message); return null; }); if (res) { await load(); showUndo(`Removed “${r.title}”`, res.undoId, () => void load()); } }} />)}

        <div className="grid gap-4 md:grid-cols-2 items-start">
          <section className="card flex flex-col gap-1" aria-label="Team">
            <span className="label mb-1" style={{ color: c }}>Team · {d.agents.length}</span>
            {d.agents.map((a) => (
              <Link key={a.id} href={`/agents/${a.id}`} className="vrow" style={{ opacity: a.live ? 1 : 0.5 }}>
                <span className="dot" style={{ background: ST[a.status] ?? ST.idle, boxShadow: a.status !== "idle" ? `0 0 8px ${ST[a.status]}` : "none" }} />
                <b className="flex-none">{a.name}</b>
                <span className="truncate flex-1" style={{ color: "var(--muted)" }}>{a.status === "working" && a.detail ? a.detail : a.short}{a.venture !== id ? " · helping" : ""}{!a.live ? ` · phase ${a.phase}` : ""}</span>
                <span className="flex-none text-[11px]" style={{ color: "var(--dim)" }}>{a.lastRunAt ? timeAgo(a.lastRunAt) : ""}</span>
              </Link>
            ))}
          </section>
          <section className="card flex flex-col gap-2" aria-label="Recent">
            <span className="label" style={{ color: c }}>Recent</span>
            {recent.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing yet. Hand-offs, approvals and board changes show here{lead ? <>; <Link href={`/command?say=${encodeURIComponent(`@${lead.id} `)}`}>give {lead.name} a task</Link></> : ""}.</span>}
            {recent.slice(0, 8).map((e) => <div key={e.id} className="text-[12px] grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2"><span style={{ color: "var(--dim)" }}>{fmtTime(e.at)}</span><span className="break-words">{e.summary}</span></div>)}
            <Link href="/activity" className="text-[11px] tracking-[0.14em] uppercase" style={{ color: c }}>Full log ›</Link>
          </section>
        </div>
      </div>
    </Shell>
  );
}

/** One number: big, with its change and trend. Updating it is one tap away instead of always on screen. */
function MetricTile({ m, color, busy, onAdd, onFix, onDelete }: { m: Metric; color: string; busy: boolean; onAdd: (v: number) => Promise<boolean>; onFix: (v: number) => Promise<boolean>; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [fix, setFix] = useState(false);
  const goodDir = m.delta === undefined || m.delta === 0 ? undefined : (m.good === "down" ? m.delta < 0 : m.delta > 0);
  const n = Number(value), ok = value.trim() !== "" && Number.isFinite(n);
  const submit = async (e: FormEvent) => { e.preventDefault(); if (!ok) return; if (await (fix ? onFix(n) : onAdd(n))) { setValue(""); setOpen(false); setFix(false); } };
  return (
    <div className="card flex flex-col gap-1.5 min-w-0" style={{ borderColor: `color-mix(in srgb, ${color} 35%, transparent)` }}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] tracking-[0.14em] uppercase truncate flex-1" style={{ color: "var(--muted)" }}>{m.label}</span>
        <button className="msg-act flex-none" aria-expanded={open} onClick={() => { setOpen(!open); setFix(false); setValue(""); }}>{open ? "Close" : "Update"}</button>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="display text-3xl leading-none" style={{ color: m.latest === undefined ? "var(--dim)" : "var(--ink-bright)" }}>{fmtMetric(m.latest, m.unit)}</span>
        {goodDir !== undefined && <span className="text-[12px]" style={{ color: goodDir ? "var(--green)" : "var(--red)" }}>{m.delta! > 0 ? "▲" : "▼"} {fmtMetric(Math.abs(m.delta!), m.unit)}</span>}
      </div>
      {m.series.length > 1 && <Sparkline points={m.series} color={color} width={180} height={32} />}
      <span className="text-[11px]" style={{ color: "var(--dim)" }}>{m.at ? `updated ${timeAgo(m.at)}` : "no readings yet"}</span>
      {open && (
        <form className="flex flex-col gap-1.5 pt-1.5 border-t" style={{ borderColor: "var(--line)" }} onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
          <div className="flex gap-1">
            <input className="input h-8 flex-1 min-w-0 text-[12px]" type="number" step="any" autoFocus placeholder={fix ? "corrected value" : "new reading"} aria-label={fix ? `Corrected ${m.label}` : `New ${m.label} reading`} value={value} onChange={(e) => setValue(e.target.value)} />
            <button className="btn btn-sm h-8 btn-primary" disabled={busy || !ok}>{fix ? "Fix" : "Add"}</button>
          </div>
          {m.latestId && (
            <div className="flex gap-3 text-[11px]">
              <button type="button" className="msg-act" onClick={() => { setFix(!fix); setValue(fix ? "" : String(m.latest ?? "")); }}>{fix ? "Add a new reading instead" : "Fix the latest instead"}</button>
              <button type="button" className="msg-act ml-auto" style={{ color: "var(--red)" }} disabled={busy} onClick={() => void onDelete()}>Delete latest</button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}

type Draft = { id?: string; title: string; status: string; fields: Record<string, string> };

/** A tracker list (leads, jobs, holdings…): open items first, filter by status, everything editable. */
function Board({ k, color, busy, onSave, onRemove }: { k: Kind; color: string; busy: boolean; onSave: (body: unknown) => Promise<boolean>; onRemove: (r: Item) => Promise<void> }) {
  const [filter, setFilter] = useState<string>("open");
  const [editing, setEditing] = useState<string | null>(null); // record id or "new"
  const [draft, setDraft] = useState<Draft>({ title: "", status: k.statuses[0]!, fields: {} });
  const name = k.label.replace(/\s*\(.*\)$/, ""), owner = k.label.includes("(") ? k.label.slice(k.label.indexOf("(") + 1, -1) : null;
  const closed = k.items.filter((r) => CLOSED.has(r.status)), open = k.items.filter((r) => !CLOSED.has(r.status));
  const counts = Object.fromEntries(k.statuses.map((s) => [s, k.items.filter((r) => r.status === s).length]));
  const shown = filter === "open" ? open : filter === "all" ? k.items : k.items.filter((r) => r.status === filter);
  const value = k.fields.find((f) => f.type === "money");
  const rest = k.fields.filter((f) => f !== value);
  const fmt = (v: unknown, type?: string) => (v === undefined || v === "" ? "" : type === "money" ? fmtMetric(Number(v), "$") : String(v));

  const start = (r?: Item) => { setEditing(r?.id ?? "new"); setDraft(r ? { id: r.id, title: r.title, status: r.status, fields: Object.fromEntries(k.fields.map((f) => [f.key, r.fields[f.key] === undefined ? "" : String(r.fields[f.key])])) } : { title: "", status: k.statuses[0]!, fields: {} }); };
  const save = async () => {
    if (!draft.title.trim()) return;
    const fields: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(draft.fields)) { if (v === "") continue; const f = k.fields.find((x) => x.key === key); fields[key] = f?.type === "number" || f?.type === "money" ? Number(v) : v; }
    if (await onSave({ kind: k.kind, id: draft.id, title: draft.title.trim(), status: draft.status, fields })) setEditing(null);
  };
  const form = (
    <div className="flex flex-col gap-2 p-3 border" style={{ borderColor: color }}>
      <div className="flex flex-wrap gap-2">
        <input className="input h-9 flex-1 min-w-48" placeholder="Title" aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus />
        <select className="input h-9 w-40" aria-label="Status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{k.statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      </div>
      <div className="grid gap-2 grid-cols-2 md:grid-cols-4">
        {k.fields.map((f) => <label key={f.key} className="flex flex-col gap-1 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>{f.label}<input className="input h-9 normal-case tracking-normal" type={f.type === "number" || f.type === "money" ? "number" : f.type === "date" ? "date" : "text"} value={draft.fields[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, fields: { ...draft.fields, [f.key]: e.target.value } })} /></label>)}
      </div>
      <div className="flex gap-2 justify-end"><button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-sm btn-primary" disabled={busy || !draft.title.trim()} onClick={() => void save()}>Save</button></div>
    </div>
  );

  return (
    <section className="card flex flex-col gap-3" aria-label={k.label}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="label m-0 font-normal" style={{ color }}>{name} · {open.length} open</h2>
        <span className="text-[11px]" style={{ color: "var(--muted)" }}>{owner ? `kept by ${owner}` : ""}{k.addedWeek ? `${owner ? " · " : ""}${k.addedWeek} added this week` : ""}</span>
        <button className="btn btn-sm ml-auto" onClick={() => start()}>Add</button>
      </div>
      {k.items.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Filter ${name.toLowerCase()}`}>
          {[["open", `Open ${open.length}`], ...k.statuses.filter((s) => counts[s]).map((s) => [s, `${s} ${counts[s]}`]), ["all", `All ${k.items.length}`]].map(([v, label]) => (
            <button key={v} className="vchip" aria-pressed={filter === v} onClick={() => setFilter(v!)} style={filter === v ? { borderColor: color, color: "var(--ink-bright)" } : undefined}>{label}</button>
          ))}
        </div>
      )}
      {editing === "new" && form}
      {k.items.length === 0 && editing !== "new" && <span className="text-[12px]" style={{ color: "var(--muted)" }}>No {name.toLowerCase()} yet. {owner ?? "The team"} adds them as they work, or press Add.</span>}
      {k.items.length > 0 && shown.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing {filter === "open" ? "open" : `marked ${filter}`}.{closed.length && filter === "open" ? ` ${closed.length} closed under All.` : ""}</span>}
      <ul className="m-0 p-0 list-none flex flex-col">
        {shown.map((r) => editing === r.id ? <li key={r.id}>{form}</li> : (
          <li key={r.id} className="vitem">
            <button className="vitem-main" onClick={() => start(r)} title="Edit">
              <b>{r.title}</b>
              <span>{rest.map((f) => { const v = fmt(r.fields[f.key], f.type); return v ? `${f.key === "next" ? "Next: " : ""}${v}` : ""; }).filter(Boolean).join(" · ") || <i>No details yet</i>}</span>
            </button>
            {value && <span className="vitem-val">{fmt(r.fields[value.key], "money")}</span>}
            <select className="vstatus" aria-label={`Status of ${r.title}`} value={r.status} style={{ color: tone(r.status) ?? color, borderColor: tone(r.status) ?? color }} onChange={(e) => void onSave({ kind: k.kind, id: r.id, title: r.title, status: e.target.value })}>{k.statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            <span className="vitem-when">{timeAgo(r.updatedAt).replace(" ago", "")}</span>
            <button className="vitem-x" onClick={() => void onRemove(r)} aria-label={`Remove ${r.title}`} title="Remove (you can undo)">×</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
