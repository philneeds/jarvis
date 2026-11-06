"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLive } from "@/lib/live";
import { api, post, timeAgo } from "@/lib/api";
import { layoutWeb } from "@/lib/webLayout";
import type { AgentLive, ModelKey } from "@/lib/types";

const ST: Record<string, string> = { working: "var(--st-working)", waiting: "var(--st-needs)", idle: "var(--st-idle)", error: "var(--st-error)", paused: "var(--st-paused)" };
const MIN_S = 0.15, MAX_S = 4;

/** Text width in px for the layout, measured with the fonts the page really has. */
function useMeasure() {
  const [ready, setReady] = useState(0);
  useEffect(() => { let live = true; void document.fonts?.ready.then(() => { if (live) setReady((r) => r + 1); }); return () => { live = false; }; }, []);
  return useMemo(() => {
    const ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    const cache = new Map<string, number>();
    const fn = (text: string, font: string) => {
      const k = `${font}|${text}`;
      let w = cache.get(k);
      if (w === undefined) {
        const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
        if (ctx) { ctx.font = font; w = ctx.measureText(text).width; } else w = text.length * size * 0.62;
        cache.set(k, w);
      }
      return w;
    };
    return { fn, ready };
  }, [ready]);
}

/** Size of an element, kept current. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const on = () => setSize((s) => (s.w === el.offsetWidth && s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight }));
    on();
    const ro = new ResizeObserver(on); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function AgentWeb({ initial }: { initial?: string }) {
  const { state, refresh } = useLive();
  const [sel, setSel] = useState<string | null>(initial ?? null);
  const [q, setQ] = useState("");
  const [maxLayer, setMaxLayer] = useState(3);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [keyOpen, setKeyOpen] = useState(false);
  const [top, setTop] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [mapRef, map] = useSize<HTMLDivElement>();
  const [barRef, bar] = useSize<HTMLDivElement>();
  const [legendRef, legend] = useSize<HTMLDivElement>();
  const [keyRef, keyBtn] = useSize<HTMLButtonElement>();
  const [wide, setWide] = useState(true);
  const measure = useMeasure();
  // The view: map units at the top-left corner and screen pixels per map unit.
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const viewRef = useRef(view); viewRef.current = view;
  // The bubble the view is zoomed to, kept in view when the layout changes; none means "show the whole web".
  const anchor = useRef<string | null>(initial ?? null);

  // The page fills the screen below the header; measure where it starts.
  useLayoutEffect(() => {
    const on = () => { const el = rootRef.current; if (el) setTop(Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY))); };
    const mq = window.matchMedia("(min-width: 768px)");
    const onMq = () => setWide(mq.matches);
    on(); onMq(); window.addEventListener("resize", on); mq.addEventListener("change", onMq);
    return () => { window.removeEventListener("resize", on); mq.removeEventListener("change", onMq); };
  }, []);

  const compact = map.w > 0 && map.w < 640;
  // Keep the web clear of the toolbar and the key (on the phone the key folds into a button).
  const padT = bar.h + (compact ? 14 : 20), padB = (wide ? legend.h : keyBtn.h) + (compact ? 12 : 16), padX = compact ? 8 : 24;
  const availW = Math.max(1, map.w - padX * 2), availH = Math.max(1, map.h - padT - padB);

  const agents = useMemo(() => (state?.agents ?? []).filter((a) => a.id !== "interface"), [state]);
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const shown = useMemo(() => agents.filter((a) => a.layer <= maxLayer), [agents, maxLayer]);
  // Positions depend only on who is shown and the space they get, not on status changes.
  const shape = shown.map((a) => `${a.id}:${a.parent}:${a.venture}`).join(",");
  const ventures = useMemo(() => (state ? Object.values(state.ventures).filter((v) => v.id !== "root") : []), [state]);
  const web = useMemo(
    () => layoutWeb(shown, { compact, aspect: availW / availH, measure: measure.fn, ventureLabel: (v) => state?.ventures[v]?.short ?? v.toUpperCase() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shape, compact, Math.round((availW / availH) * 20), measure, ventures.map((v) => v.short).join()],
  );
  const pos = web.pos;

  const links = useMemo(() => shown.filter((a) => a.parent && pos[a.parent]).map((a) => [a.parent!, a.id] as const), [shown, pos]);
  const cross = useMemo(() => { const seen = new Set<string>(); const out: [string, string][] = []; shown.forEach((a) => [...(a.links ?? []), ...(a.alsoReportsTo ?? [])].forEach((o) => { if (!pos[o]) return; const k = [a.id, o].sort().join("|"); if (!seen.has(k)) { seen.add(k); out.push([a.id, o]); } })); return out; }, [shown, pos]);
  const ql = q.trim().toLowerCase();
  const match = (a: AgentLive) => !ql || a.name.toLowerCase().includes(ql) || a.short.toLowerCase().includes(ql) || a.id.includes(ql);
  const hits = ql ? shown.filter(match) : [];

  const fitView = useCallback(() => {
    const b = web.bounds; const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    if (!map.w || !map.h || bw <= 0 || bh <= 0) return;
    const s = Math.min(availW / bw, availH / bh, 1.6);
    setView({ s, x: b.x0 - (padX + (availW - bw * s) / 2) / s, y: b.y0 - (padT + (availH - bh * s) / 2) / s });
  }, [web, map.w, map.h, availW, availH, padX, padT]);

  // Where a chosen bubble should land: the middle of the map, or on the phone the strip above the details sheet.
  const target = useCallback(() => {
    if (wide) return { x: padX + availW / 2, y: padT + availH / 2 };
    const mapTop = mapRef.current?.getBoundingClientRect().top ?? 0;
    const sheetTop = window.innerHeight * 0.4 - 44 - mapTop;
    return { x: map.w / 2, y: (padT + Math.max(padT + 40, sheetTop)) / 2 };
  }, [wide, padX, padT, availW, availH, map.w, mapRef]);

  const focus = useCallback((id: string) => {
    const p = web.pos[id]; if (!p || !map.w) return;
    const fitS = Math.min(availW / Math.max(1, web.bounds.x1 - web.bounds.x0), availH / Math.max(1, web.bounds.y1 - web.bounds.y0));
    const s = Math.min(MAX_S, Math.max(1.3, fitS * 1.6));
    const t = target();
    anchor.current = id;
    setView({ s, x: p.x - t.x / s, y: p.y - t.y / s });
  }, [web, map.w, availW, availH, target]);

  /** On the phone the details sheet covers the lower half: slide the tapped bubble into view. */
  const reveal = (id: string) => {
    const p = web.pos[id]; if (wide || !p) return;
    const t = target();
    setView((v) => ({ ...v, x: p.x - t.x / v.s, y: p.y - t.y / v.s }));
  };

  // Fit the whole web whenever its shape or the space changes; open on ?agent= if one was asked for.
  useEffect(() => {
    if (!map.w || !shown.length) return;
    if (anchor.current && web.pos[anchor.current]) focus(anchor.current); else { anchor.current = null; fitView(); }
  }, [web, map.w, map.h, shown.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = useCallback((k: number, px?: number, py?: number) => {
    anchor.current = null;
    setView((v) => {
      const s = Math.min(MAX_S, Math.max(MIN_S, v.s * k));
      const sx = px ?? padX + availW / 2, sy = py ?? padT + availH / 2;
      const wx = v.x + sx / v.s, wy = v.y + sy / v.s;
      return { s, x: wx - sx / s, y: wy - sy / s };
    });
  }, [padX, padT, availW, availH]);

  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const r = el.getBoundingClientRect(); zoomAt(e.deltaY > 0 ? 1 / 1.12 : 1.12, e.clientX - r.left, e.clientY - r.top); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  // Drag to pan, pinch to zoom. A tap only selects when the finger didn't move.
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; x: number; y: number; vx: number; vy: number; pinch?: { d: number; s: number; wx: number; wy: number } }>({ moved: false, x: 0, y: 0, vx: 0, vy: 0 });
  const local = (e: React.PointerEvent) => { const r = svgRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onDown = (e: React.PointerEvent) => {
    const p = local(e); ptrs.current.set(e.pointerId, p);
    const v = viewRef.current;
    if (ptrs.current.size === 1) gesture.current = { moved: false, x: p.x, y: p.y, vx: v.x, vy: v.y };
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      anchor.current = null;
      gesture.current = { ...gesture.current, moved: true, pinch: { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: v.s, wx: v.x + mx / v.s, wy: v.y + my / v.s } };
      svgRef.current?.setPointerCapture?.(e.pointerId);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const p = local(e); ptrs.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g.pinch && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const s = Math.min(MAX_S, Math.max(MIN_S, g.pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / g.pinch.d)));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      setView({ s, x: g.pinch.wx - mx / s, y: g.pinch.wy - my / s });
      return;
    }
    if (!g.moved && Math.hypot(p.x - g.x, p.y - g.y) > 5) { g.moved = true; anchor.current = null; svgRef.current?.setPointerCapture?.(e.pointerId); }
    if (g.moved && !g.pinch) { const s = viewRef.current.s; setView((v) => ({ ...v, x: g.vx - (p.x - g.x) / s, y: g.vy - (p.y - g.y) / s })); }
  };
  const onUp = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    const g = gesture.current;
    if (g.pinch && ptrs.current.size === 1) {
      // One finger left after a pinch: carry on panning from here.
      const [p] = [...ptrs.current.values()] as [{ x: number; y: number }];
      const v = viewRef.current; gesture.current = { moved: true, x: p.x, y: p.y, vx: v.x, vy: v.y };
    }
  };
  const pick = (id: string | null) => { if (gesture.current.moved) return; setSel(id); setMsg(undefined); if (id) reveal(id); };

  const curve = (a: { x: number; y: number }, b: { x: number; y: number }, bend: number) => { const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y; return `M${a.x},${a.y}Q${mx - dy * bend},${my + dx * bend} ${b.x},${b.y}`; };
  const near = new Set<string>();
  if (sel && byId[sel]) { near.add(sel); const d = byId[sel]!; if (d.parent) near.add(d.parent); agents.filter((a) => a.parent === sel).forEach((k) => near.add(k.id)); cross.forEach(([a, b]) => { if (a === sel) near.add(b); if (b === sel) near.add(a); }); }

  // A venture staffed from other teams (the Analyzer) gets a dashed ring around each member instead of a district.
  const owned = new Set(agents.map((x) => x.venture));
  const halos = ventures.filter((v) => !owned.has(v.id)).flatMap((v) => shown.filter((a) => a.serves?.includes(v.id) && pos[a.id]).map((a) => ({ v, a, p: pos[a.id]! })));

  const a = sel ? byId[sel] : undefined;
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setMsg(undefined); try { const r = (await fn()) as { message?: string | { text: string } }; setMsg(typeof r?.message === "string" ? r.message : r?.message?.text); await refresh(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  const team = a ? agents.filter((x) => x.parent === a.id) : [];
  const ww = a ? cross.filter(([x, y]) => x === a.id || y === a.id).map(([x, y]) => (x === a.id ? y : x)).filter((o) => !a.alsoReportsTo?.includes(o) && !byId[o]?.alsoReportsTo?.includes(a.id)) : [];
  const choose = (id: string) => { setSel(id); setMsg(undefined); if (!pos[id]) setMaxLayer(3); focus(id); };
  const vw = map.w / view.s, vh = map.h / view.s;
  const pressed = { borderColor: "var(--accent)", background: "rgba(60,130,255,0.25)", color: "var(--ink-bright)" };

  return (
    <div ref={rootRef} className="flex-1 flex flex-col md:flex-row min-h-0 md:h-[calc(100dvh-var(--web-top))]" style={{ "--web-top": `${top}px` } as React.CSSProperties}>
      <div ref={mapRef} className="relative flex-none md:flex-1 overflow-hidden h-[max(440px,calc(100dvh-var(--web-top)-4rem-env(safe-area-inset-bottom,0px)))] md:h-auto">
        <div ref={barRef} className="absolute left-3 top-3 right-3 flex flex-wrap items-start gap-2 z-10">
          <div className="relative order-1 flex-1 md:flex-none min-w-0 max-w-60 md:w-52">
            <input className="input h-9" placeholder="Find an agent" aria-label="Find an agent" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { const hit = agents.find(match); if (hit) { choose(hit.id); setQ(""); } } if (e.key === "Escape") setQ(""); }} />
            {ql && <p className="absolute left-0 top-full mt-1 m-0 px-2 py-1 text-[11px] whitespace-nowrap panel" style={{ color: hits.length ? "var(--muted)" : "var(--amber)", background: "rgba(5,12,32,0.92)" }}>{hits.length ? `${hits.length} match${hits.length === 1 ? "" : "es"} · Enter to open ${hits[0]!.name}` : agents.some(match) ? "Only in deeper layers · press Enter or tap All" : `No agent called “${q.trim()}”`}</p>}
          </div>
          <div className="tabs order-3 md:order-2 w-full md:w-[240px]" role="group" aria-label="Layers shown">
            {[1, 2, 3].map((l) => <button key={l} className="h-9" aria-pressed={maxLayer === l} onClick={() => setMaxLayer(l)} style={maxLayer === l ? pressed : undefined}>{l === 1 ? "Main" : l === 2 ? "+ Sub 1" : "All"}</button>)}
          </div>
          <div className="order-2 md:order-3 ml-auto flex gap-1.5">
            <button className="btn btn-sm w-9 px-0 text-[14px]" onClick={() => zoomAt(1.3)} aria-label="Zoom in">+</button>
            <button className="btn btn-sm w-9 px-0 text-[14px]" onClick={() => zoomAt(1 / 1.3)} aria-label="Zoom out">−</button>
            <button className="btn btn-sm" onClick={() => { anchor.current = null; fitView(); }} aria-label="Fit the whole web">Fit</button>
          </div>
        </div>

        <svg ref={svgRef} className="absolute inset-0 w-full h-full block touch-none select-none" style={{ cursor: "grab" }} viewBox={`${view.x} ${view.y} ${vw || 1} ${vh || 1}`} role="img" aria-label="Spiderweb of Phil's agents around Jarvis, grouped by venture" data-scale={view.s.toFixed(3)} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClick={() => pick(null)}>
          {web.clusters.map((c) => {
            const v = state?.ventures[c.venture]; const color = v?.color ?? "var(--accent)";
            return (
              <g key={c.venture} className="district" opacity={ql ? 0.35 : 1}>
                <rect className="hull" x={c.x - c.w / 2} y={c.y - c.h / 2} width={c.w} height={c.h} rx={14} fill={`color-mix(in srgb, ${color} 8%, rgba(5,12,32,0.55))`} stroke={`color-mix(in srgb, ${color} 50%, transparent)`} />
                <text className="hull-label" x={c.x} y={c.labelY} fill={color} fontSize={c.labelFs}>{c.label}</text>
              </g>
            );
          })}
          {links.map(([p, c]) => <path key={`${p}-${c}`} className={byId[p]?.venture === byId[c]?.venture && p !== "jarvis" ? "link inner" : "link"} d={curve(pos[p]!, pos[c]!, 0.06)} style={sel && (p === sel || c === sel) ? { stroke: "var(--accent)", strokeWidth: 2.2, opacity: 1 } : sel || ql ? { opacity: 0.2 } : undefined} />)}
          {cross.map(([p, c]) => <path key={`x${p}-${c}`} className="xlink" d={curve(pos[p]!, pos[c]!, 0.16)} style={sel && (p === sel || c === sel) ? { stroke: "var(--accent)", strokeWidth: 2, opacity: 1 } : sel || ql ? { opacity: 0.15 } : undefined} />)}
          {halos.map(({ v, a: m, p }) => <rect key={`${v.id}-${m.id}`} className="hull" x={p.x - p.w / 2 - 4} y={p.y - p.h / 2 - 4} width={p.w + 8} height={p.h + 8} rx={(p.h + 8) / 2} fill="none" stroke={v.color} strokeDasharray="4 3" opacity={ql ? 0.3 : 0.9}><title>{v.label}</title></rect>)}
          {shown.map((d) => {
            const p = pos[d.id]; if (!p) return null;
            const color = state!.ventures[d.venture]?.color ?? "var(--accent)";
            const dim = ql ? !match(d) : sel ? !near.has(d.id) : false;
            const nameY = p.sub ? -p.h * 0.1 : p.fs * 0.36;
            return (
              <g key={d.id} className={`node ${sel === d.id ? "sel" : ""} ${!d.live ? "off" : ""} ${d.id === "jarvis" ? "core-node" : ""}`} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.18 : 1} tabIndex={0} role="button" data-id={d.id} aria-label={`${d.name}, ${d.short}, ${d.status}${d.live ? "" : ", not live yet"}`} onClick={(e) => { e.stopPropagation(); pick(d.id); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(d.id); } }}>
                <title>{d.name} · {d.short} · {d.status}{d.live ? "" : ` · live in Phase ${d.phase}`}</title>
                <rect className="bub" x={-p.w / 2} y={-p.h / 2} width={p.w} height={p.h} rx={p.h / 2} stroke={color} style={d.status === "working" ? { filter: `drop-shadow(0 0 8px ${color})` } : undefined} />
                <text y={nameY} fontSize={p.fs}>{d.name}</text>
                {p.sub && <text className="sub" y={p.h * 0.1 + p.subFs + 1} fontSize={p.subFs}>{p.sub}</text>}
                <circle className="st" cx={p.w / 2 - p.h * 0.22} cy={-p.h / 2 + p.h * 0.18} r={compact ? 3.5 : 4.5} fill={ST[d.status] ?? ST.idle} style={{ filter: d.status !== "idle" ? `drop-shadow(0 0 4px ${ST[d.status]})` : undefined }} />
              </g>
            );
          })}
        </svg>
        {!state && <p className="absolute inset-0 m-0 flex items-center justify-center text-[12px]" style={{ color: "var(--muted)" }}>Loading the web…</p>}

        <div className="absolute left-3 bottom-3 right-3 flex items-end gap-2 pointer-events-none">
          <div ref={legendRef} className={`${keyOpen ? "flex" : "hidden"} md:flex flex-wrap gap-x-3 gap-y-1 text-[10px] tracking-[0.08em] uppercase px-3 py-2 panel pointer-events-auto`} style={{ color: "var(--muted)", background: "rgba(5,12,32,0.85)" }}>
            {ventures.map((v) => <span key={v.id} className="flex items-center gap-1.5"><i className={`inline-block w-2.5 h-2.5 rounded-full border-2 ${owned.has(v.id) ? "" : "border-dashed"}`} style={{ borderColor: v.color }} />{v.short}</span>)}
            <span className="flex items-center gap-1.5"><span className="dot dot-working" />working</span><span className="flex items-center gap-1.5"><span className="dot dot-waiting" />waiting on you</span><span className="flex items-center gap-1.5"><span className="dot dot-error" />error</span><span className="flex items-center gap-1.5"><span className="dot dot-paused" />paused</span>
            <span className="flex items-center gap-1.5"><i className="inline-block w-4 h-2.5 rounded-full border border-dashed opacity-60" style={{ borderColor: "var(--ink)" }} />not live yet</span>
          </div>
          <button ref={keyRef} className="btn btn-sm md:hidden pointer-events-auto flex-none ml-auto" aria-expanded={keyOpen} onClick={() => setKeyOpen(!keyOpen)}>{keyOpen ? "Hide key" : "Key"}</button>
        </div>
      </div>

      <aside className={`scroll md:w-[340px] md:flex-none md:border-l p-5 flex flex-col gap-4 ${a ? "max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(44px+env(safe-area-inset-bottom,0px))] max-md:max-h-[60dvh] max-md:border-t-2 max-md:shadow-[0_-12px_40px_rgba(0,0,0,0.6)]" : "border-t md:border-t-0"}`} style={{ borderColor: a ? "var(--accent-soft)" : "var(--line)", background: a ? "rgba(5,12,32,0.96)" : "rgba(5,12,32,0.7)", zIndex: 15 }} aria-live="polite">
        {!a ? (
          <>
            <span className="label">The web</span>
            <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Each box is a venture; Jarvis sits in the middle. Tap a bubble for its job, team, model and controls. Drag to pan, scroll or pinch to zoom. Dashed, faded bubbles aren&apos;t live in this phase yet.</p>
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3].map((l) => <div key={l} className="card p-3"><b className="block display text-xl">{agents.filter((x) => x.layer === l).length}</b><span className="text-[11px]" style={{ color: "var(--muted)" }}>{l === 1 ? "work with Jarvis" : l === 2 ? "in sub-layer 1" : "in sub-layer 2"}</span></div>)}
            </div>
            <span className="label">Secondary main layer</span>
            <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
              {agents.filter((x) => x.layer === 1).map((h) => <li key={h.id}><button className="w-full flex justify-between items-baseline gap-2 px-2 py-1.5 bg-transparent border-0 text-left cursor-pointer hover:bg-[rgba(124,196,255,0.08)]" onClick={() => choose(h.id)}><b className="display" style={{ color: state?.ventures[h.venture]?.color }}>{h.name}</b><span className="text-[11px] text-right" style={{ color: "var(--muted)" }}>{h.short} · <span className="dot" style={{ background: ST[h.status], width: 7, height: 7 }} /></span></button></li>)}
            </ul>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <span className="label flex-1" style={{ color: state?.ventures[a.venture]?.color }}>{["Main layer", "Secondary main layer", "Sub-layer 1", "Sub-layer 2"][a.layer]} · {state?.ventures[a.venture]?.label}</span>
              <button className="btn btn-sm w-8 px-0 flex-none md:hidden" onClick={() => setSel(null)} aria-label="Close details">×</button>
            </div>
            <h2 className="display font-bold text-3xl leading-none m-0" style={{ color: "var(--ink-bright)" }}>{a.name}</h2>
            <p className="m-0 flex items-center gap-2" style={{ color: "var(--muted)" }}><span className={`dot dot-${a.status}`} />{a.status}{a.detail ? ` · ${a.detail}` : ""}{!a.live ? ` · goes live in Phase ${a.phase}` : ""}</p>
            <p className="m-0 text-[12px] leading-relaxed">{a.desc}</p>
            {a.lastError && <p className="m-0 text-[11px]" style={{ color: "var(--red)" }}>{a.lastError.slice(0, 300)}</p>}
            <dl className="m-0 grid gap-3">
              <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Last run</dt><dd className="m-0 text-[12px]">{timeAgo(a.lastRunAt)}</dd></div>
              {a.parent && <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Reports to</dt><dd className="m-0 flex flex-wrap gap-1.5">{[a.parent, ...(a.alsoReportsTo ?? [])].map((p) => <button key={p} className="btn btn-sm" onClick={() => choose(p)}>{byId[p]?.name}</button>)}</dd></div>}
              {team.length > 0 && <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Team ({team.length})</dt><dd className="m-0 flex flex-wrap gap-1.5">{team.map((t) => <button key={t.id} className="btn btn-sm" onClick={() => choose(t.id)}>{t.name}</button>)}</dd></div>}
              {ww.length > 0 && <div><dt className="label mb-1" style={{ color: "var(--muted)" }}>Also works with</dt><dd className="m-0 flex flex-wrap gap-1.5">{ww.map((t) => <button key={t} className="btn btn-sm" onClick={() => choose(t)}>{byId[t]?.name}</button>)}</dd></div>}
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
                  <Link className="btn btn-sm" href={`/agents/${a.id}`}>Settings</Link>
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

