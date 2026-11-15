"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLive } from "@/lib/live";
import { api, post } from "@/lib/api";
import { LEVEL_NAME, horizonOf, useBase } from "@/lib/base";
import { useAutoDone } from "@/components/DonePanel";
import { useTask, type TaskRef } from "@/lib/task";
import type { AgentLive, Approval, AttentionItem } from "@/lib/types";
import type { CoreState } from "@/components/Core";
import { approveLabel } from "@/components/ApprovalsPanel";

/**
 * Home as a base: Jarvis's core in the middle, one building per venture, and the agents who are working or
 * waiting on Phil standing outside. Everything shown is live state HQ already has; nothing here is scored or
 * invented. A venture whose agents aren't live yet is an empty lot.
 */

export interface BaseTarget { id: string; name: string }

type Pt = [number, number];
const OX = 720, OY = 100, HW = 37, HH = 18.5, N = 15;
/** The part of the drawing that's shown; everything is placed in these units and scales with the page. */
const VB = { x: 150, y: 70, w: 1140, h: 630 };
const P = (i: number, j: number, z = 0): Pt => [OX + (i - j) * HW, OY + (i + j) * HH - z];
const pts = (a: Pt[]) => a.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
const poly = (a: Pt[], fill: string, extra = "") => `<polygon points="${pts(a)}" fill="${fill}" ${extra}/>`;
const seg = (p: Pt, q: Pt, stroke: string, w = 2, extra = "") => `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" ${extra}/>`;
/** Venture colours come from the registry; anything that isn't a plain hex falls back to the accent. */
const hex = (c?: string) => (c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : "#7CC4FF");

/** Where each venture sits: tile column, tile row, footprint. Live ventures ring the front; the back row fills in as phases open. */
const SPOTS: { id: string; i: number; j: number; f: number }[] = [
  { id: "money", i: 0, j: 3.5, f: 2 }, { id: "philneeds", i: 3.5, j: 0, f: 2 }, { id: "range", i: 6.6, j: 0, f: 2 }, { id: "acres", i: 0.25, j: 13.75, f: 1 },
  { id: "command", i: 3, j: 12, f: 2 }, { id: "personal", i: 7.75, j: 12.25, f: 2 }, { id: "jdpm", i: 12, j: 12, f: 2 }, { id: "crypto", i: 12.25, j: 7.75, f: 2 }, { id: "proedge", i: 12, j: 3, f: 2 },
];
/** Back to front, with the core in its place, so nearer buildings draw over farther ones. */
const ORDER = [...SPOTS.map((s) => ({ ...s, key: s.i + s.j + s.f * 2 })), { id: "core", i: 6, j: 6, f: 3, key: 18 }].sort((a, b) => a.key - b.key);

type Light = "working" | "needs" | "idle";
function rng(seed: number) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
const seedOf = (id: string) => [...id].reduce((n, c) => n + c.charCodeAt(0), 7);

function box(i: number, j: number, a: number, b: number, z0: number, H: number, work: boolean, col: string, roofA = 0.3) {
  const A = P(i, j, z0 + H), B = P(i + a, j, z0 + H), C = P(i + a, j + b, z0 + H), D = P(i, j + b, z0 + H), Bb = P(i + a, j, z0), Cb = P(i + a, j + b, z0), Db = P(i, j + b, z0);
  return poly([D, C, Cb, Db], work ? "#21407F" : "#1B2C52") + poly([C, B, Bb, Cb], work ? "#152D62" : "#111E3D") + poly([A, B, C, D], "#24386A") + poly([A, B, C, D], col, `fill-opacity="${roofA}"`) + `<polyline points="${pts([D, C, B])}" fill="none" stroke="${col}" stroke-width="2"/>`;
}
function wall(f: Pt, t: Pt, z0: number, z1: number, cols: number, rows: number, pick: () => string) {
  let s = "";
  const at = (u: number, z: number) => P(f[0] + (t[0] - f[0]) * u, f[1] + (t[1] - f[1]) * u, z);
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const u1 = (k + 0.22) / cols, u2 = (k + 0.78) / cols, za = z0 + ((r + 0.25) / rows) * (z1 - z0), zb = z0 + ((r + 0.75) / rows) * (z1 - z0), fill = pick();
    if (fill) s += poly([at(u1, za), at(u2, za), at(u2, zb), at(u1, zb)], fill);
  }
  return s;
}
const walls = (i: number, j: number, a: number, b: number, z0: number, z1: number, cols: number, rows: number, pick: () => string) => wall([i, j + b], [i + a, j + b], z0, z1, cols, rows, pick) + wall([i + a, j + b], [i + a, j], z0, z1, cols, rows, pick);
/** Window lights: mostly blue while someone is working, warm otherwise, a few amber when something waits on Phil. */
const lights = (st: Light, r: () => number) => () => { if (r() > (st === "working" ? 0.8 : 0.42)) return "rgba(255,255,255,.07)"; return st === "working" ? (r() < 0.7 ? "#A8D6FF" : "rgba(255,226,170,.85)") : st === "needs" && r() < 0.35 ? "#FFB547" : "rgba(255,226,170,.8)"; };
function gable(i: number, j: number, a: number, b: number, z0: number, R: number, col: string) {
  const A = P(i, j, z0), B = P(i + a, j, z0), C = P(i + a, j + b, z0), D = P(i, j + b, z0), R1 = P(i, j + b / 2, z0 + R), R2 = P(i + a, j + b / 2, z0 + R);
  return poly([A, B, R2, R1], "#16284F") + poly([D, C, R2, R1], "#22386B") + poly([D, C, R2, R1], col, 'fill-opacity=".5"') + poly([C, B, R2], "#152750") + poly([C, B, R2], col, 'fill-opacity=".22"') + seg(R1, R2, col, 2) + seg(D, C, col, 1.5);
}

/** Each venture's building is shaped by what it does, so it reads without its label. Returns the drawing and its height. */
const SHAPE: Record<string, (i: number, j: number, st: Light, col: string, r: () => number) => { s: string; top: number }> = {
  // control tower: low base, slim shaft, wide glass cab, antenna
  command(i, j, st, col, r) {
    const w = st === "working", c = i + 1;
    let s = box(i, j, 2, 2, 0, 24, w, col) + walls(i, j, 2, 2, 4, 20, 6, 1, lights(st, r));
    s += box(i + 0.68, j + 0.68, 0.64, 0.64, 24, 46, w, col, 0.15) + box(i + 0.3, j + 0.3, 1.4, 1.4, 70, 20, w, col, 0.5);
    s += walls(i + 0.3, j + 0.3, 1.4, 1.4, 73, 87, 5, 1, () => (w ? "#BFE2FF" : "rgba(255,226,170,.85)"));
    s += seg(P(c, j + 1, 90), P(c, j + 1, 116), "#B8C8E0", 1.5) + `<circle class="base-blink" cx="${P(c, j + 1, 118)[0]}" cy="${P(c, j + 1, 118)[1]}" r="2.5" fill="#fff"/>`;
    return { s, top: 118 };
  },
  // workshop: pitched roof, big door, and a crane
  jdpm(i, j, st, col, r) {
    let s = box(i, j, 2, 2, 0, 28, false, col, 0.1) + walls(i, j, 2, 2, 6, 24, 5, 1, lights(st, r));
    const at = (u: number, z: number) => P(i + 2 * u, j + 2, z);
    s += poly([at(0.12, 0), at(0.46, 0), at(0.46, 20), at(0.12, 20)], "#0A1226") + seg(at(0.12, 7), at(0.46, 7), "#2A3C66", 1) + seg(at(0.12, 14), at(0.46, 14), "#2A3C66", 1);
    s += gable(i, j, 2, 2, 28, 18, col);
    const m: Pt = [i + 1.8, j + 0.2];
    s += seg(P(m[0], m[1], 0), P(m[0], m[1], 76), "#D9B25A", 3) + seg(P(m[0], m[1] - 0.6, 76), P(m[0], m[1] + 2.3, 76), "#D9B25A", 3) + seg(P(m[0], m[1], 88), P(m[0], m[1] + 2.3, 76), "#D9B25A", 1) + seg(P(m[0], m[1], 88), P(m[0], m[1], 76), "#D9B25A", 2);
    const hk = P(m[0], m[1] + 1.7, 76), hb = P(m[0], m[1] + 1.7, 56);
    s += seg(hk, hb, "#B8C8E0", 1) + `<rect x="${hb[0] - 5}" y="${hb[1]}" width="10" height="8" fill="${col}"/>`;
    return { s, top: 86 };
  },
  // relay tower: stacked block, mast, dish and signal rings
  crypto(i, j, st, col, r) {
    const w = st === "working";
    let s = box(i, j, 2, 2, 0, 30, w, col) + walls(i, j, 2, 2, 4, 26, 6, 2, lights(st, r));
    s += box(i + 0.45, j + 0.45, 1.1, 1.1, 30, 28, w, col, 0.5) + walls(i + 0.45, j + 0.45, 1.1, 1.1, 34, 54, 3, 2, lights(st, r));
    const t = P(i + 1, j + 1, 96), d = P(i + 1, j + 1, 86);
    s += seg(P(i + 1, j + 1, 58), t, "#B8C8E0", 2) + `<ellipse cx="${d[0] + 9}" cy="${d[1]}" rx="15" ry="8" transform="rotate(-35 ${d[0] + 9} ${d[1]})" fill="#C9D6F2" stroke="${col}" stroke-width="2"/>`;
    s += [18, 28, 38].map((q, k) => `<path class="base-ping" style="animation-delay:${k * 0.35}s" d="M${t[0] + q * 0.6} ${t[1] - q} A${q} ${q} 0 0 1 ${t[0] + q} ${t[1] - q * 0.2}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round"/>`).join("");
    return { s, top: 112 };
  },
  // house: warm windows, pitched roof, chimney, two trees
  personal(i, j, _st, col, r) {
    let s = "";
    for (const [ti, tj] of [[i + 2.1, j + 0.2], [i + 2.25, j + 1.2]] as Pt[]) { const b = P(ti, tj), t = P(ti, tj, 18); s += `<ellipse cx="${b[0]}" cy="${b[1]}" rx="8" ry="3" fill="#000" fill-opacity=".35"/>` + seg(b, t, "#5A4A3A", 2.5) + `<circle cx="${t[0]}" cy="${t[1] - 6}" r="11" fill="#1F6B58"/><circle cx="${t[0] - 4}" cy="${t[1] - 10}" r="6" fill="#2C8A70"/>`; }
    s += box(i + 0.15, j + 0.15, 1.7, 1.7, 0, 26, false, col, 0.1) + walls(i + 0.15, j + 0.15, 1.7, 1.7, 7, 21, 4, 1, () => (r() < 0.7 ? "rgba(255,226,170,.9)" : "rgba(255,255,255,.07)"));
    s += gable(i + 0.15, j + 0.15, 1.7, 1.7, 26, 20, col) + box(i + 1.25, j + 0.75, 0.24, 0.24, 36, 20, false, col, 0.1);
    return { s, top: 60 };
  },
  // office with a rooftop billboard: a chart going up
  proedge(i, j, st, col, r) {
    let s = box(i, j, 2, 2, 0, 42, st === "working", col) + walls(i, j, 2, 2, 4, 38, 6, 3, lights(st, r));
    const at = (u: number, z: number) => P(i + 0.2 + 1.6 * u, j + 1.85, z);
    s += seg(at(0.15, 42), at(0.15, 50), "#B8C8E0", 2) + seg(at(0.85, 42), at(0.85, 50), "#B8C8E0", 2);
    s += poly([at(0, 50), at(1, 50), at(1, 84), at(0, 84)], "#081226", `stroke="${col}" stroke-width="2"`);
    s += `<polyline points="${pts([at(0.12, 58), at(0.36, 66), at(0.56, 62), at(0.86, 77)])}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` + poly([at(0.86, 77), at(0.74, 76), at(0.84, 70)], col);
    return { s, top: 88 };
  },
  // bank: tall lit columns under a pediment
  money(i, j, st, col) {
    let s = box(i, j, 2, 2, 0, 30, st === "working", col, 0.12);
    s += wall([i, j + 2], [i + 2, j + 2], 3, 27, 6, 1, () => "rgba(255,226,170,.85)") + wall([i + 2, j + 2], [i + 2, j], 3, 27, 6, 1, () => "rgba(255,226,170,.6)");
    return { s: s + gable(i, j, 2, 2, 30, 14, col), top: 48 };
  },
  // studio with a big play-button screen
  philneeds(i, j, st, col, r) {
    let s = box(i, j, 2, 2, 0, 28, st === "working", col) + walls(i, j, 2, 2, 4, 24, 6, 2, lights(st, r));
    const at = (u: number, z: number) => P(i + 0.2 + 1.6 * u, j + 1.85, z);
    s += seg(at(0.15, 28), at(0.15, 36), "#B8C8E0", 2) + seg(at(0.85, 28), at(0.85, 36), "#B8C8E0", 2) + poly([at(0, 36), at(1, 36), at(1, 72), at(0, 72)], "#081226", `stroke="${col}" stroke-width="2"`) + poly([at(0.38, 44), at(0.38, 64), at(0.68, 54)], col);
    return { s, top: 76 };
  },
  // lab: a low hall with a glass dome, and a tower beside it
  range(i, j, st, col, r) {
    const w = st === "working", d = P(i + 0.7, j + 1.3, 22);
    let s = box(i, j, 2, 2, 0, 22, w, col) + walls(i, j, 2, 2, 4, 18, 6, 1, lights(st, r));
    s += box(i + 1.05, j + 0.15, 0.8, 0.8, 22, 36, w, col, 0.5) + walls(i + 1.05, j + 0.15, 0.8, 0.8, 26, 54, 2, 3, lights(st, r));
    s += `<path d="M${d[0] - 24} ${d[1]} A24 20 0 0 1 ${d[0] + 24} ${d[1]} Z" fill="#9FD2FF" fill-opacity=".35" stroke="${col}" stroke-width="1.5"/>`;
    return { s, top: 62 };
  },
  // barn and silo, on the small lot
  acres(i, j, _st, col) {
    const s = box(i + 0.08, j + 0.08, 0.72, 0.84, 0, 14, false, col, 0.1) + wall([i + 0.08, j + 0.92], [i + 0.8, j + 0.92], 4, 11, 2, 1, () => "rgba(255,226,170,.85)") + gable(i + 0.08, j + 0.08, 0.72, 0.84, 14, 10, col) + box(i + 0.78, j + 0.12, 0.2, 0.2, 0, 30, false, col, 0.5);
    return { s, top: 34 };
  },
};

/** The ground slab and its grid. Never changes. */
/**
 * The ground. The raised, lit slab covers only what's built (from tile i0, j0 to the front corner); the rest of the
 * plot is flat, dark, dashed land that the slab grows into as ventures open.
 */
function ground(i0: number, j0: number) {
  let g = "";
  if (i0 > 0 || j0 > 0) g += poly([P(0, 0), P(N, 0), P(N, N), P(0, N)], "#060A18", 'stroke="#6EB8FF" stroke-opacity=".22" stroke-width="1.2" stroke-dasharray="7 6"');
  g += poly([P(i0, N), P(N, N), P(N, N, -22), P(i0, N, -22)], "#070D1E") + poly([P(N, N), P(N, j0), P(N, j0, -22), P(N, N, -22)], "#050A17");
  g += poly([P(i0, j0), P(N, j0), P(N, N), P(i0, N)], "url(#base-ground)", 'stroke="#6EB8FF" stroke-opacity=".45" stroke-width="1.5"');
  for (let k = Math.floor(i0) + 1; k < N; k++) g += seg(P(k, j0), P(k, N), "#6EB8FF", 1, 'stroke-opacity=".06"');
  for (let k = Math.floor(j0) + 1; k < N; k++) g += seg(P(i0, k), P(N, k), "#6EB8FF", 1, 'stroke-opacity=".06"');
  return g;
}
/** Jarvis's core building (the orb on top is drawn live, so it can follow the voice state). */
const CORE = (() => {
  const r = rng(31);
  return box(6, 6, 3, 3, 0, 22, true, "#6EB8FF", 0.2) + box(6.6, 6.6, 1.8, 1.8, 22, 88, true, "#9FD2FF", 0.3)
    + wall([6.6, 8.4], [8.4, 8.4], 28, 104, 4, 6, () => (r() < 0.75 ? "#A8D6FF" : "rgba(255,255,255,.08)")) + wall([8.4, 8.4], [8.4, 6.6], 28, 104, 4, 6, () => (r() < 0.6 ? "#7FB4EE" : "rgba(255,255,255,.06)"));
})();

const clipText = (s: string | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Money, trades and code ships are decided on the full card, where the limits and the whole proposal are in view. */
const heavy = (a: Approval) => a.kind === "money" || a.kind === "strategy" || /^(trade|strategy|robinhood|payment|invoice|transfer|wallet|order)\.|^code\.ship$|^hq\.update$/.test(typeof a.payload?.action === "string" ? a.payload.action : "");

interface Row {
  id: string; i: number; j: number; f: number; label: string; color: string; live: boolean; phase: number;
  agents: AgentLive[]; working: AgentLive[]; errors: AgentLive[]; approvals: Approval[]; todos: AttentionItem[];
  light: Light; top: number; art: string; L: Pt; level: number; scale: number;
}
/** A building's size for levels 1 to 5: it grows as the venture's goals are met. */
const LEVEL_SCALE = [0.8, 0.8, 0.86, 0.92, 0.99, 1.07];
interface Ready { agentId: string; name: string; missing: string[] }

/**
 * The "your call" sign over a building: a raised gold tile with a "!", pointing down at it, bobbing. Red when an agent
 * there hit a problem. More than one waiting shows as a small count on its corner.
 */
function Alert({ x, y, n, kind, label, onOpen, onKey }: { x: number; y: number; n: number; kind: "need" | "bad"; label: string; onOpen: () => void; onKey: (e: React.KeyboardEvent) => void }) {
  const w = 40, h = 40, t = y - h / 2, l = x - w / 2, g = kind === "need" ? "base-alert-gold" : "base-alert-red";
  const edge = kind === "need" ? "#4A2A00" : "#4A0A14";
  // The tile, with a short point under its middle.
  const d = `M${l + 8},${t} h${w - 16} q8,0 8,8 v${h - 16} q0,8 -8,8 h-${w / 2 - 14} l-6,8 l-6,-8 h-${w / 2 - 14} q-8,0 -8,-8 v-${h - 16} q0,-8 8,-8 z`;
  return (
    <>
    <ellipse cx={x} cy={y + h / 2 + 22} rx={11} ry={3.5} fill="#000" fillOpacity={0.35} className="base-bub-shadow" />
    <g role="button" tabIndex={0} aria-label={label} className="base-bub" onClick={onOpen} onKeyDown={onKey}>
      <path d={d} fill={`url(#${g})`} stroke={edge} strokeWidth={2.5} strokeLinejoin="round" />
      <path d={`M${l + 6},${t + 9} q0,-6 6,-6 h${w - 24} q6,0 6,6`} fill="none" stroke="#fff" strokeOpacity={0.55} strokeWidth={2.5} strokeLinecap="round" />
      <text x={x} y={y + 11} textAnchor="middle" className="base-alert-mark">!</text>
      {n > 1 && (
        <g>
          <circle cx={l + w - 1} cy={t + 1} r={9} fill="#0A1226" stroke={edge === "#4A2A00" ? "#FFD27A" : "#FF8A9A"} strokeWidth={1.5} />
          <text x={l + w - 1} y={t + 5} textAnchor="middle" className="base-alert-count">{n}</text>
        </g>
      )}
    </g>
    </>
  );
}

function Person({ at, body, ring, dot }: { at: Pt; body: string; ring?: boolean; dot?: string }) {
  return (
    <g className={ring ? "base-bob" : undefined}>
      <ellipse cx={at[0]} cy={at[1]} rx={8} ry={3.4} fill="#000" fillOpacity={0.45} />
      <rect x={at[0] - 5} y={at[1] - 15} width={10} height={14} rx={4} fill={body} />
      <circle cx={at[0]} cy={at[1] - 19.5} r={5} fill="#F2E3CF" />
      {ring && <circle cx={at[0]} cy={at[1] - 11} r={15} fill="none" stroke="#8FCBFF" strokeWidth={1.5} strokeOpacity={0.85} />}
      {dot && <circle className="base-blink" cx={at[0]} cy={at[1] - 31} r={3.6} fill={dot} />}
    </g>
  );
}

export function Base({ core = "idle", target, onTarget }: { core?: CoreState; target: BaseTarget | null; onTarget: (t: BaseTarget | null) => void }) {
  const { state, pending, attention, setPending } = useLive();
  const [sel, setSel] = useState<string | null>(null);
  const [pop, setPop] = useState<string | null>(null);
  const [popAt, setPopAt] = useState(0); // which item of the open card: problems first, then approvals, then to-dos
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { base, goals, toggle, repick } = useBase();
  const { data: autoDone } = useAutoDone();
  const task = useTask();
  const doneToday = (autoDone?.items ?? []).filter((x) => !x.undone && Date.now() - Date.parse(x.at) < 86_400_000).length;
  const [menu, setMenu] = useState<"today" | "health" | "level" | null>(null);
  const [ready, setReady] = useState<{ phase: number; agents: Ready[] } | null>(null);
  const levels = base?.levels;

  const rows = useMemo<Row[]>(() => {
    if (!state) return [];
    // Jarvis himself lives in the core; anything filed under him shows on Command, the venture he leads.
    const home = (agentId: string) => { const v = state.agents.find((a) => a.id === agentId)?.venture; return !v || v === "root" ? "command" : v; };
    const open = attention.filter((x) => x.status === "open");
    return SPOTS.map((s) => {
      const agents = state.agents.filter((a) => a.id !== "jarvis" && a.id !== "interface" && (a.venture === s.id || (s.id === "command" && a.venture === "root")));
      const live = agents.some((a) => a.live);
      const working = agents.filter((a) => a.status === "working"), errors = agents.filter((a) => a.status === "error");
      const approvals = pending.filter((p) => home(p.agentId) === s.id);
      const todos = open.filter((x) => (x.venture && x.venture !== "root" ? x.venture : home(x.agentId)) === s.id);
      const light: Light = working.length ? "working" : approvals.length || todos.length || agents.some((a) => a.status === "waiting") ? "needs" : "idle";
      const color = hex(state.ventures[s.id as keyof typeof state.ventures]?.color);
      const drawn = live && SHAPE[s.id] ? SHAPE[s.id]!(s.i, s.j, light, color, rng(seedOf(s.id))) : { s: "", top: 42 };
      const level = live ? levels?.[s.id]?.level ?? 1 : 0, scale = live ? LEVEL_SCALE[level] ?? 1 : 1;
      drawn.top = drawn.top * scale + (level === 5 ? 18 : 0);
      return {
        ...s, label: state.ventures[s.id as keyof typeof state.ventures]?.short ?? s.id.toUpperCase(), color, live, phase: Math.min(...agents.map((a) => a.phase), 9),
        agents, working, errors, approvals, todos, light, top: drawn.top, art: drawn.s, L: P(s.i + s.f / 2, s.j + s.f / 2, drawn.top + 22), level, scale,
      };
    }).filter((r) => r.agents.length > 0);
  }, [state, pending, attention, levels]);

  // The slab reaches one tile past the farthest live building (and always holds the core), so opening a venture grows it.
  const land = useMemo(() => {
    const live = rows.filter((r) => r.live);
    const edge = (k: "i" | "j") => Math.max(0, Math.floor(Math.min(5, ...live.map((r) => r[k])) - 1));
    return ground(edge("i"), edge("j"));
  }, [rows]);

  // An empty lot shows what its agents still need connected before its phase is worth starting.
  const lockedPhase = (() => { const r = rows.find((x) => x.id === sel); return r && !r.live ? r.phase : null; })();
  useEffect(() => {
    if (lockedPhase === null || lockedPhase > 3) { setReady(null); return; }
    let on = true;
    api<{ phase: number; agents: Ready[] }>(`/api/phase/readiness?phase=${lockedPhase}`).then((r) => { if (on) setReady(r); }).catch(() => undefined);
    return () => { on = false; };
  }, [lockedPhase]);

  if (!state) return <div className="w-full" style={{ aspectRatio: `${VB.w} / ${VB.h}` }} aria-busy="true" />;

  const row = (id: string | null) => rows.find((r) => r.id === id);
  const cur = row(sel), popRow = row(pop);
  const waiting = pending.length + attention.filter((x) => x.status === "open").length;
  const problems = [
    ...(state.status.killSwitch.all ? ["Everything is paused. Press Resume in the header to start again."] : []),
    ...(state.status.level !== "green" && !state.status.killSwitch.all ? [state.status.text] : []),
    ...Object.entries(state.providers ?? {}).filter(([, v]) => !v.ok).map(([k, v]) => `${k} isn't answering${v.reason ? `: ${v.reason}` : "."}`),
    ...rows.flatMap((r) => r.errors.map((a) => `${a.name} hit an error${a.lastError ? `: ${clipText(a.lastError, 90)}` : "."}`)),
  ];
  const today = base?.today.items ?? [], todayDone = today.filter((x) => x.done).length;

  const pick = (id: string) => { setSel(id); setPop(null); setError(undefined); };
  const clear = () => { setSel(null); setPop(null); onTarget(null); setError(undefined); };
  const key = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };

  const approve = async (a: Approval) => {
    setBusy(true); setError(undefined);
    try { await post(`/api/approvals/${a.id}/approve`, {}); setPending((p) => p.filter((x) => x.id !== a.id)); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const done = async (t: AttentionItem) => {
    setBusy(true); setError(undefined);
    try { await post(`/api/attention/${t.id}/done`); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  // Everything waiting, in one list, for the phone: problems, then approvals, then to-dos.
  const queue = rows.flatMap((r) => [
    ...r.errors.map((a) => ({ key: `e${a.id}`, ref: undefined as TaskRef | undefined, tag: r.label, color: r.color, text: `${a.name} hit an error`, act: <Link className="btn btn-sm" href={`/web?agent=${a.id}`}>Open ›</Link> })),
    ...r.approvals.map((a) => ({ key: a.id, ref: { kind: "approval" as const, id: a.id }, tag: r.label, color: r.color, text: a.title, act: heavy(a) ? <Link className="btn btn-sm" href="/attention#approve">Review ›</Link> : <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void approve(a)}>{approveLabel(a)}</button> })),
    ...r.todos.map((t) => ({ key: t.id, ref: { kind: "todo" as const, id: t.id }, tag: r.label, color: r.color, text: t.title, act: <button className="btn btn-sm" disabled={busy} onClick={() => void done(t)}>Done ✓</button> })),
  ]);

  const orb = P(7.5, 7.5, 150), corePt = P(7.5, 7.5);
  const pct = (p: Pt) => ({ left: `${((p[0] - VB.x) / VB.w) * 100}%`, top: `${((p[1] - VB.y) / VB.h) * 100}%` });

  // The card that opens from a bubble: problems first, then approvals, then to-dos, one at a time.
  const card = popRow && (() => {
    const n = popRow.errors.length + popRow.approvals.length + popRow.todos.length;
    if (!n) return null;
    const at = Math.min(popAt, n - 1);
    const e = popRow.errors[at], a = e ? undefined : popRow.approvals[at - popRow.errors.length], t = e || a ? undefined : popRow.todos[at - popRow.errors.length - popRow.approvals.length];
    const who = (id: string) => state.agents.find((x) => x.id === id)?.name ?? id;
    return (
      <div className="base-pop" data-side={popRow.L[0] > 900 ? "left" : "right"} data-kind={e ? "bad" : "need"} style={pct([popRow.L[0], Math.max(VB.y + 20, popRow.L[1] - 130)])} role="dialog" aria-label={`${popRow.label}: waiting on you`}>
        <button className="base-x" onClick={() => setPop(null)} aria-label="Close">✕</button>
        <span className="base-tag">{e ? "Problem" : a ? "Needs you" : "To do"} · {popRow.label}{n > 1 ? ` · ${at + 1} of ${n}` : ""}</span>
        {n > 1 && <span className="base-btns" style={{ marginTop: 0 }}><button className="btn btn-sm" onClick={() => { setError(undefined); setPopAt((at + n - 1) % n); }} aria-label="Previous">‹</button><button className="btn btn-sm" onClick={() => { setError(undefined); setPopAt((at + 1) % n); }} aria-label="Next">Next ›</button></span>}
        {e ? (
          <>
            <b>{e.name} hit an error</b>
            <span className="base-dim">{clipText(e.lastError ?? e.detail ?? "No detail was recorded.", 180)}</span>
            <div className="base-btns"><Link className="btn btn-sm" href={`/web?agent=${e.id}`}>Open {e.name.split(" ")[0]} ›</Link></div>
          </>
        ) : a ? (
          <>
            <b>{a.title}</b>
            <span className="base-dim">{who(a.agentId)} · {clipText(a.effect ?? "Approving only records your decision.", 200)}</span>
            {heavy(a)
              ? <><span className="base-dim">Money, trades and code changes are decided on the full card.</span><div className="base-btns"><Link className="btn btn-sm btn-primary" href="/attention#approve">Review the full card ›</Link><button className="btn btn-sm" onClick={() => { setPop(null); task.open({ kind: "approval", id: a.id }); }}>Discuss ›</button></div></>
              : <div className="base-btns"><button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void approve(a)}>{approveLabel(a)}</button><button className="btn btn-sm" onClick={() => { setPop(null); task.open({ kind: "approval", id: a.id }); }}>Discuss ›</button></div>}
          </>
        ) : t ? (
          <>
            <b>{t.title}</b>
            <span className="base-dim">{who(t.agentId)}{t.why ? ` · ${clipText(t.why, 180)}` : ""}</span>
            <div className="base-btns"><button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void done(t)}>Done ✓</button><button className="btn btn-sm" onClick={() => { setPop(null); task.open({ kind: "todo", id: t.id }); }}>Open ›</button></div>
          </>
        ) : null}
        {error && <span style={{ color: "var(--red)" }}>{error}</span>}
      </div>
    );
  })();

  return (
    <section aria-label="Your base" className="w-full flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] tracking-[0.14em] uppercase">
        {base && (() => {
          const p = base.player, live = rows.filter((r) => r.live), baseLv = live.reduce((n, r) => n + r.level, 0);
          return (
            <div className="relative mr-2">
              <button className="lvl" aria-expanded={menu === "level"} onClick={() => setMenu(menu === "level" ? null : "level")} aria-label={`Level ${p.level}, ${p.xp} of ${p.next} XP to the next. Base level ${baseLv}.`}>
                <svg className="lvl-hex" viewBox="0 0 40 44" aria-hidden="true"><defs><linearGradient id="lvl-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#9FD8FF" /><stop offset="1" stopColor="#2F6FD8" /></linearGradient></defs><path d="M20 2 37 11.5v21L20 42 3 32.5v-21z" fill="url(#lvl-g)" stroke="#0B2350" strokeWidth="2.5" strokeLinejoin="round" /><path d="M9 13 20 7l11 6" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" /><text x="20" y="28" textAnchor="middle">{p.level}</text></svg>
                <span className="lvl-body"><span className="lvl-name">Phil <i>· base lv {baseLv}</i></span><span className="lvl-bar"><b style={{ width: `${Math.round((p.xp / p.next) * 100)}%` }} /></span><span className="lvl-xp">{p.xp} / {p.next} XP</span></span>
              </button>
              {menu === "level" && (
                <div className="base-menu" role="dialog" aria-label="Your level">
                  <span className="base-tag" style={{ color: "var(--accent)" }}>Level {p.level} · {p.total} XP in all · {p.next - p.xp} to level {p.level + 1}</span>
                  <span className="base-dim">XP comes only from things that got done:</span>
                  <ul className="m-0 pl-4 flex flex-col gap-0.5">
                    <li>Trophies (goal steps met) · {p.from.trophies} × 10</li>
                    <li>Days with all of today&apos;s 3 done · {p.from.fullDays} × 15</li>
                    <li>To-dos ticked off · {p.from.todosDone} × 5</li>
                    <li>Cards you decided · {p.from.decisions} × 2</li>
                  </ul>
                  <span className="base-dim">Base level is every live building&apos;s level added up ({live.map((r) => `${r.label} ${r.level}`).join(", ")}). Buildings level up when their goals&apos; milestones are met.</span>
                  <Link href="/goals" className="btn btn-sm self-start">Goals ›</Link>
                </div>
              )}
            </div>
          );
        })()}
        <Link href="/attention" className="base-chip" style={waiting ? { borderColor: "var(--amber)", color: "var(--amber)" } : undefined}>{waiting} need you ›</Link>
        {doneToday > 0 && <Link href="/attention#done" className="base-chip" style={{ borderColor: "var(--green)", color: "var(--green)" }} title="Reversible work agents did on their own in the last day; each can be undone">{doneToday} done for you ›</Link>}
        <div className="relative">
          <button className="base-chip" aria-expanded={menu === "health"} onClick={() => setMenu(menu === "health" ? null : "health")} style={{ borderColor: problems.length ? "var(--red)" : "var(--green)", color: problems.length ? "var(--red)" : "var(--green)" }}>{problems.length ? `${problems.length} problem${problems.length === 1 ? "" : "s"} ▾` : "Healthy ▾"}</button>
          {menu === "health" && (
            <div className="base-menu" role="dialog" aria-label="Health">
              {problems.length === 0 ? <span>Every agent is running, every provider is answering, and nothing is paused.</span> : <ul className="m-0 pl-4 flex flex-col gap-1">{problems.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              <Link href="/settings" className="btn btn-sm self-start">Connections and backups ›</Link>
            </div>
          )}
        </div>
        <div className="relative">
          <button className="base-chip" aria-expanded={menu === "today"} onClick={() => setMenu(menu === "today" ? null : "today")} style={today.length && todayDone === today.length ? { borderColor: "var(--green)", color: "var(--green)" } : undefined}>Today {todayDone} / {today.length} ▾</button>
          {menu === "today" && (
            <div className="base-menu" role="dialog" aria-label="Today's three">
              <span className="base-tag" style={{ color: "var(--gold)" }}>Today&apos;s 3 · {base?.today.by === "david" ? "David's pick" : base?.today.by === "phil" ? "your pick" : "HQ's pick"}{base && base.streak > 0 ? ` · ${base.streak} day streak` : ""}</span>
              {today.length === 0 && <span className="base-dim">Nothing to pick from yet. Set a goal and the next step toward it shows up here.</span>}
              {today.map((x) => (
                <button key={x.id} className="base-todo" data-done={x.done} onClick={() => void toggle(x.id)} aria-pressed={x.done}><i aria-hidden="true" /><span>{x.text}</span></button>
              ))}
              <div className="base-btns"><Link href="/goals" className="btn btn-sm">All goals ›</Link>{today.length > 0 && <button className="btn btn-sm" onClick={() => void repick()} title="HQ picks again from what's waiting and your goals as they stand">Pick again</button>}</div>
            </div>
          )}
        </div>
      </div>

      <div className="base-wrap">
      <div className="base-stage">
        <svg viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`} className={`base-svg base-core-${core}`} role="group" aria-label="Jarvis in the middle, one building for each venture">
          <defs>
            <linearGradient id="base-ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0A1430" /><stop offset="1" stopColor="#0F1E44" /></linearGradient>
            <radialGradient id="base-orb"><stop offset="0" stopColor="#BFE2FF" stopOpacity=".95" /><stop offset=".4" stopColor="#6EB8FF" stopOpacity=".55" /><stop offset="1" stopColor="#6EB8FF" stopOpacity="0" /></radialGradient>
            <filter id="base-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="16" /></filter>
            <linearGradient id="base-alert-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFE58A" /><stop offset=".55" stopColor="#FFC23A" /><stop offset="1" stopColor="#E8920A" /></linearGradient>
            <linearGradient id="base-alert-red" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FF9AA8" /><stop offset=".55" stopColor="#FF5068" /><stop offset="1" stopColor="#C8203C" /></linearGradient>
          </defs>
          <g dangerouslySetInnerHTML={{ __html: land }} />
          {/* A line from the core to every live venture; it runs while someone there is working. */}
          {rows.filter((r) => r.live).map((r) => {
            const c = P(r.i + r.f / 2, r.j + r.f / 2), on = r.working.length > 0;
            return (
              <g key={r.id}>
                <line x1={corePt[0]} y1={corePt[1]} x2={c[0]} y2={c[1]} stroke={on ? "#8FCBFF" : r.color} strokeOpacity={on ? 0.95 : 0.4} strokeWidth={on ? 3 : 2} strokeLinecap="round" className={on ? "base-flow" : undefined} />
                {on && <circle className="base-packet" r={5} cx={c[0]} cy={c[1]} fill="#EAF6FF" style={{ "--dx": `${(corePt[0] - c[0]).toFixed(0)}px`, "--dy": `${(corePt[1] - c[1]).toFixed(0)}px` } as React.CSSProperties} />}
              </g>
            );
          })}
          {ORDER.map((o) => {
            if (o.id === "core") {
              return (
                <g key="core" role="button" tabIndex={0} aria-label="Jarvis. Clears your selection so the next message goes to him." className="base-hit" onClick={clear} onKeyDown={key(clear)}>
                  {/* The click area is the orb and the painted building, not a box: a box this size covered the agents standing outside PhilNeeds and parts of two buildings behind. */}
                  <circle cx={orb[0]} cy={orb[1]} r={40} fill="transparent" />
                  <g dangerouslySetInnerHTML={{ __html: CORE }} />
                  <line x1={orb[0]} y1={orb[1] + 20} x2={orb[0]} y2={orb[1] + 40} stroke="#9FD2FF" strokeWidth={2} />
                  <circle className="base-breathe" cx={orb[0]} cy={orb[1]} r={40} fill="url(#base-orb)" />
                  <ellipse className="base-spin" cx={orb[0]} cy={orb[1]} rx={30} ry={11} fill="none" stroke="#9FD2FF" strokeWidth={1.5} strokeDasharray="3 6" />
                  <circle className="base-orb" cx={orb[0]} cy={orb[1]} r={12} fill="#EAF6FF" />
                </g>
              );
            }
            const r = row(o.id);
            if (!r) return null;
            const D = P(r.i, r.j + r.f), B = P(r.i + r.f, r.j), C = P(r.i + r.f, r.j + r.f), y0 = r.L[1] - 18;
            const said = `${r.label}: ${r.live ? `${r.agents.length} agents, ${r.working.length} working, ${r.approvals.length + r.todos.length} waiting on you${r.errors.length ? `, ${r.errors.length} with an error` : ""}` : `not built yet, phase ${r.phase}`}`;
            // Only agents who are working, in error, or holding something for Phil stand outside. Three at most, then "+N".
            const holding = new Set([...r.approvals.map((a) => a.agentId), ...r.todos.map((t) => t.agentId)]);
            const outside = r.live ? [...r.working, ...r.agents.filter((a) => a.status !== "working" && (a.status === "error" || a.status === "waiting" || holding.has(a.id)))] : [];
            const e = 0.4;
            return (
              <g key={r.id} role="button" tabIndex={0} aria-label={said} aria-pressed={sel === r.id} className="base-hit" onClick={() => pick(r.id)} onKeyDown={key(() => pick(r.id))}>
                <rect x={D[0] - 10} y={y0} width={B[0] - D[0] + 20} height={C[1] - y0 + 26} fill="transparent" />
                {sel === r.id && <polygon className="base-flow" points={pts([P(r.i - e, r.j - e), P(r.i + r.f + e, r.j - e), P(r.i + r.f + e, r.j + r.f + e), P(r.i - e, r.j + r.f + e)])} fill="rgba(255,255,255,.05)" stroke={r.color} strokeWidth={2.5} />}
                {r.live ? (
                  <>
                    {r.light === "working" && <ellipse cx={P(r.i + r.f / 2, r.j + r.f / 2, 40)[0]} cy={P(r.i + r.f / 2, r.j + r.f / 2, 40)[1]} rx={r.f * HW + 6} ry={78} fill="#6EB8FF" fillOpacity={0.3} filter="url(#base-glow)" />}
                    {(() => { const c = P(r.i + r.f / 2, r.j + r.f / 2); return <g transform={`translate(${c[0].toFixed(1)} ${c[1].toFixed(1)}) scale(${r.scale}) translate(${(-c[0]).toFixed(1)} ${(-c[1]).toFixed(1)})`} dangerouslySetInnerHTML={{ __html: r.art }} />; })()}
                    {r.level === 5 && (() => { const t = P(r.i + r.f / 2, r.j + r.f / 2, r.top - 8); return <><ellipse className="base-spin" cx={t[0]} cy={t[1]} rx={26} ry={10} fill="none" stroke="#FFD27A" strokeWidth={2.5} strokeDasharray="4 5" /><circle cx={t[0]} cy={t[1]} r={5} fill="#FFD27A" /></>; })()}
                  </>
                ) : (
                  // An empty lot: a dashed outline, four posts and a sign with the phase it opens in.
                  <>
                    <polygon points={pts([P(r.i, r.j, 4), P(r.i + r.f, r.j, 4), P(r.i + r.f, r.j + r.f, 4), P(r.i, r.j + r.f, 4)])} fill="#0C1530" stroke={r.color} strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="6 5" />
                    {([[0, 0], [r.f, 0], [r.f, r.f], [0, r.f]] as Pt[]).map(([a, b], k) => <line key={k} x1={P(r.i + a, r.j + b, 4)[0]} y1={P(r.i + a, r.j + b, 4)[1]} x2={P(r.i + a, r.j + b, 16)[0]} y2={P(r.i + a, r.j + b, 16)[1]} stroke={r.color} strokeOpacity={0.6} strokeWidth={2} />)}
                    {(() => { const s = P(r.i + r.f / 2, r.j + r.f / 2, 4); return <><line x1={s[0]} y1={s[1]} x2={s[0]} y2={s[1] - 22} stroke="#7A869E" strokeWidth={2} /><rect x={s[0] - 30} y={s[1] - 40} width={60} height={19} rx={3} fill="#0A1226" stroke={r.color} strokeOpacity={0.7} /><text x={s[0]} y={s[1] - 27} textAnchor="middle" className="base-sign" fill={r.color}>PHASE {r.phase}</text></>; })()}
                  </>
                )}
                {outside.slice(0, 3).map((a, k) => {
                  const u = P(r.i + 0.2 + k * 0.9, r.j + r.f + 0.5), w = a.status === "working";
                  const talk = () => { setSel(r.id); setPop(null); onTarget({ id: a.id, name: a.name }); };
                  return (
                    <g key={a.id} role="button" tabIndex={0} aria-label={`${a.name}, ${w ? "working" : a.status === "error" ? "hit an error" : "waiting on you"}. Send your next message to ${a.name}.`} className="base-hit" onClick={(ev) => { ev.stopPropagation(); talk(); }} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); talk(); } }}>
                      <rect x={u[0] - 20} y={u[1] - 38} width={40} height={56} fill="transparent" />
                      <Person at={u} body={w ? "#9FD2FF" : r.color} ring={w} dot={w ? undefined : a.status === "error" ? "#FF4F6A" : "#FFB547"} />
                      {outside.length <= 2 && <text x={u[0]} y={u[1] + 15} textAnchor="middle" className="base-lbl base-name" fill={w ? "#CFE8FF" : "#FFD9A0"}>{a.name.split(" ")[0]!.toUpperCase()}</text>}
                    </g>
                  );
                })}
                {outside.length > 3 && (() => { const u = P(r.i + 0.2 + 3 * 0.9, r.j + r.f + 0.5); return <text x={u[0]} y={u[1] - 6} textAnchor="middle" className="base-lbl" fontSize={13} fill="#E8EEFF">+{outside.length - 3}</text>; })()}
              </g>
            );
          })}
          {/* Names, the one line of work, and the bubbles sit above every building so nothing hides them. */}
          <text x={orb[0]} y={orb[1] - 50} textAnchor="middle" className="base-lbl base-big" fill="#EAF6FF">JARVIS</text>
          {rows.map((r) => {
            const n = r.approvals.length + r.todos.length, both = n > 0 && r.errors.length > 0, work = r.working.length > 0;
            const by = r.L[1] - (work ? 72 : 46);
            const openAt = (at: number) => () => { setSel(r.id); setPop(r.id); setPopAt(at); setError(undefined); };
            // The gold sign opens the first thing waiting on Phil; the red one opens the first problem.
            const open = openAt(r.errors.length), openBad = openAt(0);
            return (
              <g key={r.id}>
                <text x={r.L[0]} y={r.L[1]} textAnchor="middle" className={`base-lbl base-big ${r.live ? "" : "base-lot"}`} fill={r.color} fillOpacity={r.live ? 1 : 0.7}>{r.label}</text>
                {work && (
                  <g className="base-work">
                    <rect x={r.L[0] - 44} y={r.L[1] - 27} width={88} height={7} rx={3.5} fill="#060B1A" stroke="#8FCBFF" strokeOpacity={0.6} />
                    <rect className="base-indet" x={r.L[0] - 42} y={r.L[1] - 25.5} width={26} height={4} rx={2} fill="#8FCBFF" />
                    <text x={r.L[0]} y={r.L[1] - 33} textAnchor="middle" className="base-lbl" fontSize={10.5} fill="#CFE8FF">{r.working.length > 1 ? `${r.working.length} WORKING` : clipText(r.working[0]!.detail || "working", 26).toUpperCase()}</text>
                  </g>
                )}
                {n > 0 && <Alert x={r.L[0] - (both ? 28 : 0)} y={by} n={n} kind="need" label={`${r.label}: ${n} waiting on your decision. Open.`} onOpen={open} onKey={key(open)} />}
                {r.errors.length > 0 && <Alert x={r.L[0] + (both ? 28 : 0)} y={by} n={r.errors.length} kind="bad" label={`${r.label}: ${r.errors.length} problem${r.errors.length === 1 ? "" : "s"}. Open.`} onOpen={openBad} onKey={key(openBad)} />}
              </g>
            );
          })}
        </svg>
      </div>
      {card}
      </div>

      {queue.length > 0 && (
        <ul className="base-queue" aria-label="Waiting on you">
          {queue.slice(0, 6).map((q) => <li key={q.key}><span className="base-tag" style={{ color: q.color }}>{q.tag}</span>{q.ref ? <button className="flex-1 min-w-0 text-left bg-transparent border-0 p-0 cursor-pointer" style={{ color: "var(--ink-bright)" }} onClick={() => task.open(q.ref!)}>{q.text}</button> : <span className="flex-1 min-w-0">{q.text}</span>}{q.act}</li>)}
          {queue.length > 6 && <li><Link href="/attention">{queue.length - 6} more ›</Link></li>}
        </ul>
      )}

      {cur ? (
        <div className="base-panel" style={{ borderColor: cur.color }}>
          <div className="flex flex-col gap-1 min-w-0">
            <h2 className="display m-0 text-2xl font-bold tracking-[0.06em]" style={{ color: cur.color }}>{state.ventures[cur.id as keyof typeof state.ventures]?.label ?? cur.label}</h2>
            <span className="text-[12px]" style={{ color: "var(--muted)" }}>{cur.live ? `${cur.agents.length} agents · ${cur.working.length} working · ${cur.approvals.length + cur.todos.length} need you` : `Not built yet · opens in phase ${cur.phase} · ${cur.agents.length} agents planned`}</span>
            <div className="flex gap-2 mt-1">
              <Link className="btn btn-sm btn-primary" href={`/ventures/${cur.id}`}>Go inside ›</Link>
              <button className="btn btn-sm" onClick={clear} aria-label="Close this venture">Close</button>
            </div>
          </div>
          <ul className="base-chips">
            {cur.agents.map((a) => {
              const st = a.status === "working" ? "working" : a.status === "error" ? "error" : a.status === "waiting" || cur.approvals.some((p) => p.agentId === a.id) ? "needs" : a.live ? "idle" : "off";
              return (
                <li key={a.id}>
                  <button className="base-agent" data-st={st} aria-pressed={target?.id === a.id} onClick={() => onTarget(target?.id === a.id ? null : { id: a.id, name: a.name })} title={`Send your next message to ${a.name}`}>
                    <i aria-hidden="true" />
                    <span><b>{a.name}</b><small>{clipText(a.status === "working" ? a.detail || "working" : a.short, 34)}</small></span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col gap-1.5 min-w-0 text-[12px]">
            {cur.live ? (() => {
              const lv = levels?.[cur.id] ?? { level: 1, hits: 0, next: 1 };
              const mine = goals.filter((g) => g.venture === cur.id);
              return (
                <>
                  <span className="base-tag" style={{ color: cur.color }}>Level {lv.level} · {LEVEL_NAME[lv.level]}</span>
                  <span className="base-dim">{lv.next ? `${lv.next - lv.hits} more milestone${lv.next - lv.hits === 1 ? "" : "s"} to level ${lv.level + 1}` : "Top level"}</span>
                  {mine.slice(0, 3).map((g) => <Link key={g.id} href="/goals" className="flex items-center gap-2 min-w-0" style={{ color: "var(--ink)" }}><span className="truncate flex-1">{g.name}</span><span className="base-dim flex-none">{g.pct}%</span></Link>)}
                  {mine.length === 0 && <Link href="/goals">Give {cur.label} a goal ›</Link>}
                  {mine.length > 0 && <span className="base-dim text-[11px]">{mine.filter((g) => horizonOf(g) === "long").length} long · {mine.filter((g) => horizonOf(g) === "mid").length} mid · {mine.filter((g) => horizonOf(g) === "short").length} short term</span>}
                </>
              );
            })() : (
              <>
                <span className="base-tag">Before it opens</span>
                <span className="base-dim">You start each phase yourself, in Settings.</span>
                {ready && ready.phase === cur.phase && (() => {
                  const thin = ready.agents.filter((a) => a.missing.length && cur.agents.some((x) => x.id === a.agentId));
                  return thin.length === 0 ? <span>Everything its agents need is connected.</span> : thin.slice(0, 4).map((a) => <span key={a.agentId}>{a.name} still needs {a.missing.join(", ")}</span>);
                })()}
                <Link href="/settings">Open Settings ›</Link>
              </>
            )}
          </div>
        </div>
      ) : (
        <p className="m-0 text-center text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Click a building, a ! sign, or an agent standing outside</p>
      )}
    </section>
  );
}
