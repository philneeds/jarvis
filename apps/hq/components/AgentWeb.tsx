"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLive } from "@/lib/live";
import { api, post, timeAgo } from "@/lib/api";
import type { AgentLive, ModelKey } from "@/lib/types";

const RINGS = [0, 300, 560, 800];
const ST: Record<string, string> = { working: "var(--st-working)", waiting: "var(--st-needs)", idle: "var(--st-idle)", error: "var(--st-error)", paused: "var(--st-paused)" };

type Pos = { x: number; y: number; w: number; h: number; fs: number };

function layout(agents: AgentLive[]): Record<string, Pos> {
  const kids = (id: string) => agents.filter((a) => a.parent === id && a.id !== "interface");
  const leaves: AgentLive[] = [];
  const walk = (a: AgentLive) => { const k = kids(a.id); if (!k.length) leaves.push(a); k.forEach(walk); };
  agents.filter((a) => a.layer === 1).forEach(walk);
  // A leaf on an inner ring needs more angle than one on the outer ring to keep bubbles apart.
  const weight = (d: AgentLive) => (d.layer === 1 ? 3.2 : d.layer === 2 ? 1.5 : 1);
  const total = leaves.reduce((s, d) => s + weight(d), 0);
  const angle: Record<string, number> = {};
  let acc = 0;
  leaves.forEach((d) => { const w = weight(d); angle[d.id] = ((acc + w / 2) / total) * Math.PI * 2; acc += w; });
  const setA = (a: AgentLive): number => { const k = kids(a.id); if (!k.length) return angle[a.id]!; const as = k.map(setA); const m = as.reduce((s, x) => s + x, 0) / as.length; angle[a.id] = m; return m; };
  agents.filter((a) => a.layer === 1).forEach(setA);
  const pos: Record<string, Pos> = {};
  for (const a of agents) {
    const big = a.layer <= 1;
    const fs = a.id === "jarvis" ? 24 : big ? 17 : 13;
    const w = a.id === "jarvis" ? 170 : Math.max(big ? 120 : 64, a.name.length * (big ? 10.5 : 8) + (big ? 40 : 24));
    const h = a.id === "jarvis" ? 76 : big ? 54 : 32;
    if (a.id === "jarvis") { pos[a.id] = { x: 0, y: 0, w, h, fs }; continue; }
    if (a.id === "interface") { pos[a.id] = { x: 0, y: -130, w, h, fs }; continue; }
    const r = RINGS[a.layer] ?? 800, t = angle[a.id] ?? 0;
    pos[a.id] = { x: r * Math.sin(t), y: -r * Math.cos(t), w, h, fs };
  }
  return pos;
}

function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function AgentWeb({ initial }: { initial?: string }) {
  const { state, refresh } = useLive();
  const [sel, setSel] = useState<string | null>(initial ?? null);
  const [q, setQ] = useState("");
  const [maxLayer, setMaxLayer] = useState(3);
  const [view, setView] = useState({ x: -950, y: -950, w: 1900, h: 1900 });
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const agents = useMemo(() => (state?.agents ?? []).filter((a) => a.id !== "interface"), [state]);
  const pos = useMemo(() => layout(agents), [agents]);
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const links = useMemo(() => agents.filter((a) => a.parent && byId[a.parent]).map((a) => [a.parent!, a.id] as const), [agents, byId]);
  const cross = useMemo(() => { const seen = new Set<string>(); const out: [string, string][] = []; agents.forEach((a) => (a.links ?? []).forEach((o) => { if (!byId[o]) return; const k = [a.id, o].sort().join("|"); if (!seen.has(k)) { seen.add(k); out.push([a.id, o]); } })); return out; }, [agents, byId]);
  const visible = (a: AgentLive) => a.layer <= maxLayer;
  const ql = q.trim().toLowerCase();
  const match = (a: AgentLive) => !ql || a.name.toLowerCase().includes(ql) || a.short.toLowerCase().includes(ql) || a.id.includes(ql);

  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const k = e.deltaY > 0 ? 1.12 : 1 / 1.12; setView((v) => ({ x: v.x + (v.w - v.w * k) / 2, y: v.y + (v.h - v.h * k) / 2, w: v.w * k, h: v.h * k })); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const curve = (a: Pos, b: Pos, bend: number) => { const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y; return `M${a.x},${a.y}Q${mx - dy * bend},${my + dx * bend} ${b.x},${b.y}`; };
  const near = new Set<string>();
  if (sel && byId[sel]) { near.add(sel); const d = byId[sel]!; if (d.parent) near.add(d.parent); agents.filter((a) => a.parent === sel).forEach((k) => near.add(k.id)); cross.forEach(([a, b]) => { if (a === sel) near.add(b); if (b === sel) near.add(a); }); }

  const ventures = state ? Object.values(state.ventures).filter((v) => v.id !== "root") : [];
  const hulls = ventures.map((v) => {
    const members = agents.filter((a) => (a.venture === v.id || a.serves?.includes(v.id)) && visible(a) && pos[a.id]);
    const own = members.filter((a) => a.venture === v.id);
    if (!own.length) {
      // A venture staffed from other teams (the Analyzer): a halo around each member instead of one bubble.
      const halos = members.map((a) => { const p = pos[a.id]!; return { cx: p.x, cy: p.y, rx: p.w / 2 + 10, ry: p.h / 2 + 10 }; });
      const first = halos[0];
      return { v, h: [] as [number, number][], halos, top: first ? ([first.cx, first.cy - first.ry] as [number, number]) : null };
    }
    const pts: [number, number][] = [];
    own.forEach((a) => { const p = pos[a.id]!; for (let k = 0; k < 12; k++) { const t = (k / 12) * Math.PI * 2; pts.push([p.x + (p.w / 2 + 16) * Math.cos(t), p.y + (p.h / 2 + 16) * Math.sin(t)]); } });
    const h = hull(pts);
    return { v, h, halos: [] as { cx: number; cy: number; rx: number; ry: number }[], top: h.length ? h.reduce((a, b) => (b[1] < a[1] ? b : a)) : null };
  });

  const onDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; (e.target as Element).setPointerCapture?.(e.pointerId); };
  const onMove = (e: React.PointerEvent) => { if (!drag.current || !svgRef.current) return; const r = svgRef.current.getBoundingClientRect(); const k = view.w / r.width; setView((v) => ({ ...v, x: drag.current!.vx - (e.clientX - drag.current!.x) * k, y: drag.current!.vy - (e.clientY - drag.current!.y) * k })); };
  const onUp = () => { drag.current = null; };
  const zoom = (k: number) => setView((v) => ({ x: v.x + (v.w - v.w * k) / 2, y: v.y + (v.h - v.h * k) / 2, w: v.w * k, h: v.h * k }));
  const fit = () => setView({ x: -950, y: -950, w: 1900, h: 1900 });
  const focus = (id: string) => { const p = pos[id]; if (p) setView({ x: p.x - 450, y: p.y - 450, w: 900, h: 900 }); };

  const a = sel ? byId[sel] : undefined;
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setMsg(undefined); try { const r = (await fn()) as { message?: string | { text: string } }; setMsg(typeof r?.message === "string" ? r.message : r?.message?.text); await refresh(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  const team = a ? agents.filter((x) => x.parent === a.id) : [];
  const ww = a ? cross.filter(([x, y]) => x === a.id || y === a.id).map(([x, y]) => (x === a.id ? y : x)) : [];

  return (
    <div className="flex-1 flex flex-col md:flex-row min-h-0">
      <div className="relative flex-1 min-h-[50dvh] md:min-h-0">
        <div className="absolute left-3 top-3 right-3 flex flex-wrap gap-2 z-10">
          <input className="input w-44 h-9" placeholder="Find an agent" aria-label="Find an agent" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { const hit = agents.find(match); if (hit) { setSel(hit.id); focus(hit.id); setQ(""); } } }} />
          <div className="tabs" role="group" aria-label="Layers shown" style={{ width: 230 }}>
            {[1, 2, 3].map((l) => <button key={l} className="h-9" aria-pressed={maxLayer === l} onClick={() => setMaxLayer(l)} style={maxLayer === l ? { borderColor: "var(--accent)", background: "rgba(60,130,255,0.25)" } : undefined}>{l === 1 ? "Main" : l === 2 ? "+ Sub 1" : "All"}</button>)}
          </div>
          <div className="ml-auto flex gap-1.5"><button className="btn btn-sm" onClick={() => zoom(1 / 1.3)} aria-label="Zoom in">+</button><button className="btn btn-sm" onClick={() => zoom(1.3)} aria-label="Zoom out">−</button><button className="btn btn-sm" onClick={fit}>Fit</button></div>
        </div>
        <svg ref={svgRef} className="w-full h-full block touch-none" style={{ cursor: "grab", minHeight: "50dvh" }} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} role="img" aria-label="Spiderweb of Phil's agents around Jarvis" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClick={() => setSel(null)}>
          <g>
            {hulls.map(({ v, h, halos, top }) => (h.length >= 3 || halos.length > 0) && (
              <g key={v.id} opacity={ql ? 0.3 : 1}>
                {h.length >= 3 && <path className="hull" d={`M${h.map((p) => p.join(",")).join("L")}Z`} fill={`color-mix(in srgb, ${v.color} 9%, transparent)`} stroke={`color-mix(in srgb, ${v.color} 45%, transparent)`} />}
                {halos.map((o, i) => <ellipse key={i} className="hull" cx={o.cx} cy={o.cy} rx={o.rx} ry={o.ry} fill="none" stroke={`color-mix(in srgb, ${v.color} 70%, transparent)`} strokeDasharray="4 4" />)}
                {top && <text className="hull-label" x={top[0]} y={top[1] - 8} fill={v.color}>{v.short}</text>}
              </g>
            ))}
            {links.map(([p, c]) => pos[p] && pos[c] && visible(byId[c]!) && <path key={`${p}-${c}`} className="link" d={curve(pos[p]!, pos[c]!, 0.06)} style={sel && (p === sel || c === sel) ? { stroke: "var(--accent)", strokeWidth: 2 } : sel || ql ? { opacity: 0.25 } : undefined} />)}
            {cross.map(([p, c]) => pos[p] && pos[c] && visible(byId[p]!) && visible(byId[c]!) && <path key={`x${p}-${c}`} className="xlink" d={curve(pos[p]!, pos[c]!, 0.16)} style={sel && (p === sel || c === sel) ? { stroke: "var(--accent)", strokeWidth: 2 } : sel || ql ? { opacity: 0.2 } : undefined} />)}
            {agents.map((d) => {
              const p = pos[d.id]; if (!p || !visible(d)) return null;
              const color = state!.ventures[d.venture]?.color ?? "var(--accent)";
              const dim = ql ? !match(d) : sel ? !near.has(d.id) : false;
              const big = d.layer <= 1;
              return (
                <g key={d.id} className={`node ${sel === d.id ? "sel" : ""} ${!d.live ? "off" : ""}`} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.18 : 1} tabIndex={0} role="button" aria-label={`${d.name}, ${d.short}, ${d.status}${d.live ? "" : ", not live yet"}`} onClick={(e) => { e.stopPropagation(); setSel(d.id); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(d.id); } }}>
                  <title>{d.name} · {d.short} · {d.status}</title>
                  <ellipse rx={p.w / 2} ry={p.h / 2} stroke={color} style={d.id === "jarvis" ? { fill: "color-mix(in srgb, var(--accent) 18%, #0B1E4D)", strokeWidth: 3 } : d.status === "working" ? { filter: `drop-shadow(0 0 8px ${color})` } : undefined} />
                  <text y={big ? -2 : p.fs * 0.34} fontSize={p.fs}>{d.name}</text>
                  {big && <text className="sub" y={p.fs * 0.5 + 8} fontSize={11}>{d.short}</text>}
                  <circle cx={p.w / 2 - 6} cy={-p.h / 2 + 6} r={5} fill={ST[d.status] ?? ST.idle} style={{ filter: d.status !== "idle" ? `drop-shadow(0 0 4px ${ST[d.status]})` : undefined }} />
                </g>
              );
            })}
          </g>
        </svg>
        <div className="absolute left-3 bottom-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] tracking-[0.08em] uppercase px-3 py-2 panel" style={{ color: "var(--muted)", maxWidth: "calc(100% - 24px)" }}>
          {ventures.map((v) => <span key={v.id} className="flex items-center gap-1.5"><i className="inline-block w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: v.color }} />{v.short}</span>)}
          <span className="flex items-center gap-1.5"><span className="dot dot-working" />working</span><span className="flex items-center gap-1.5"><span className="dot dot-waiting" />waiting on you</span><span className="flex items-center gap-1.5"><span className="dot dot-error" />error</span><span className="flex items-center gap-1.5"><span className="dot dot-paused" />paused</span>
        </div>
      </div>

      <aside className="scroll md:w-[340px] md:flex-none border-t md:border-t-0 md:border-l p-5 flex flex-col gap-4 max-h-[50dvh] md:max-h-none" style={{ borderColor: "var(--line)", background: "rgba(5,12,32,0.7)" }} aria-live="polite">
        {!a ? (
          <>
            <span className="label">The web</span>
            <p className="text-[12px]" style={{ color: "var(--muted)" }}>Tap a bubble for its job, team, model and controls. Drag to pan, scroll to zoom. Faded bubbles aren&apos;t live in this phase yet.</p>
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3].map((l) => <div key={l} className="card p-3"><b className="block display text-xl">{agents.filter((x) => x.layer === l).length}</b><span className="text-[11px]" style={{ color: "var(--muted)" }}>{l === 1 ? "work with Jarvis" : l === 2 ? "in sub-layer 1" : "in sub-layer 2"}</span></div>)}
            </div>
            <span className="label">Secondary main layer</span>
            <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
              {agents.filter((x) => x.layer === 1).map((h) => <li key={h.id}><button className="w-full flex justify-between items-baseline gap-2 px-2 py-1.5 bg-transparent border-0 text-left cursor-pointer hover:bg-[rgba(124,196,255,0.08)]" onClick={() => { setSel(h.id); focus(h.id); }}><b className="display" style={{ color: state?.ventures[h.venture]?.color }}>{h.name}</b><span className="text-[11px] text-right" style={{ color: "var(--muted)" }}>{h.short} · <span className="dot" style={{ background: ST[h.status], width: 7, height: 7 }} /></span></button></li>)}
            </ul>
          </>
        ) : (
          <>
            <span className="label" style={{ color: state?.ventures[a.venture]?.color }}>{["Main layer", "Secondary main layer", "Sub-layer 1", "Sub-layer 2"][a.layer]} · {state?.ventures[a.venture]?.label}</span>
            <h2 className="display font-bold text-3xl leading-none m-0" style={{ color: "var(--ink-bright)" }}>{a.name}</h2>
            <p className="m-0 flex items-center gap-2" style={{ color: "var(--muted)" }}><span className={`dot dot-${a.status}`} />{a.status}{a.detail ? ` · ${a.detail}` : ""}{!a.live ? ` · goes live in Phase ${a.phase}` : ""}</p>
            <p className="m-0 text-[12px] leading-relaxed">{a.desc}</p>
            {a.lastError && <p className="m-0 text-[11px]" style={{ color: "var(--red)" }}>{a.lastError.slice(0, 300)}</p>}
            <dl className="m-0 grid gap-3">
              <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Last run</dt><dd className="m-0 text-[12px]">{timeAgo(a.lastRunAt)}</dd></div>
              {a.parent && <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Reports to</dt><dd className="m-0"><button className="btn btn-sm" onClick={() => setSel(a.parent!)}>{byId[a.parent]?.name}</button></dd></div>}
              {team.length > 0 && <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Team ({team.length})</dt><dd className="m-0 flex flex-wrap gap-1.5">{team.map((t) => <button key={t.id} className="btn btn-sm" onClick={() => setSel(t.id)}>{t.name}</button>)}</dd></div>}
              {ww.length > 0 && <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Also works with</dt><dd className="m-0 flex flex-wrap gap-1.5">{ww.map((t) => <button key={t} className="btn btn-sm" onClick={() => setSel(t)}>{byId[t]?.name}</button>)}</dd></div>}
              {a.serves && a.serves.length > 0 && <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Also works for</dt><dd className="m-0 flex flex-wrap gap-1.5">{a.serves.map((v) => <span key={v} className="text-[11px] px-2 py-0.5 border rounded-full" style={{ color: state?.ventures[v]?.color, borderColor: state?.ventures[v]?.color }}>{state?.ventures[v]?.label}</span>)}</dd></div>}
              <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Model</dt><dd className="m-0 flex items-center gap-2">
                <select className="input h-9 flex-1" value={a.model} aria-label="Model" disabled={a.id === "interface"} onChange={(e) => act(() => api(`/api/agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ model: e.target.value as ModelKey }) }))}>
                  {state && Object.values(state.models).filter((m) => m.key !== "web-app").map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </dd><span className="text-[11px]" style={{ color: "var(--muted)" }}>{state?.models[a.model]?.why}</span></div>
            </dl>
            {a.id !== "jarvis" && (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  {a.status === "paused" ? <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => post(`/api/agents/${a.id}/resume`))}>Resume</button> : <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => act(() => post(`/api/agents/${a.id}/pause`))}>Pause</button>}
                  <Link className="btn btn-sm" href={`/command?say=${encodeURIComponent(`@${a.id} `)}`}>Talk</Link>
                </div>
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (task.trim()) { const t = task; setTask(""); void act(() => post(`/api/agents/${a.id}/run`, { task: t })); } }}>
                  <input className="input h-9" placeholder={`Give ${a.name} a task`} aria-label={`Give ${a.name} a task`} value={task} onChange={(e) => setTask(e.target.value)} />
                  <button className="btn btn-sm btn-primary" disabled={busy || !task.trim()}>Run</button>
                </form>
                {msg && <p className="m-0 text-[12px] whitespace-pre-wrap" style={{ color: "var(--muted)" }}>{msg.slice(0, 600)}</p>}
              </div>
            )}
            {a.note && <p className="m-0 text-[11px] p-2 border border-dashed" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>{a.note}</p>}
            <button className="btn btn-sm self-start" onClick={() => setSel(null)}>Back to overview</button>
          </>
        )}
      </aside>
    </div>
  );
}
