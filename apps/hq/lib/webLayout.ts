import type { AgentLive } from "./types";

/** A box by its centre, in map units (1 unit = 1 screen pixel at 100% zoom). */
export interface Box { x: number; y: number; w: number; h: number }
export interface NodePos extends Box { fs: number; sub?: string; subFs: number }
type VentureId = AgentLive["venture"];
export interface ClusterPos extends Box { venture: VentureId; label: string; labelFs: number; labelY: number }
export interface WebLayout { pos: Record<string, NodePos>; clusters: ClusterPos[]; bounds: { x0: number; y0: number; x1: number; y1: number } }

export interface LayoutOpts {
  /** Phone-sized map: smaller type, no job titles under the leads. */
  compact: boolean;
  /** Width / height of the space the web has to fit. */
  aspect: number;
  /** Width in px of `text` set in `font` (a CSS font shorthand). */
  measure: (text: string, font: string) => number;
  ventureLabel: (venture: VentureId) => string;
}

export const NAME_FONT = (fs: number) => `700 ${fs}px "Chakra Petch", system-ui, sans-serif`;
export const SUB_FONT = (fs: number) => `500 ${fs}px "IBM Plex Mono", ui-monospace, monospace`;
export const LABEL_FONT = (fs: number) => `600 ${fs}px "IBM Plex Mono", ui-monospace, monospace`;

const SIZES = {
  wide: { jarvisFs: 22, jarvisH: 56, headFs: 15, headH: 42, leafFs: 13, leafH: 27, subFs: 10, padX: 12, gapX: 8, gapY: 10, pad: 10, labelH: 19, labelFs: 11, gap: 16 },
  compact: { jarvisFs: 17, jarvisH: 34, headFs: 13.5, headH: 26, leafFs: 12.5, leafH: 23, subFs: 9, padX: 8, gapX: 5, gapY: 6, pad: 6, labelH: 15, labelFs: 10.5, gap: 9 },
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

interface Built { venture: VentureId; label: string; labelFs: number; w: number; h: number; rows: { id: string; dx: number; dy: number }[][] }

/**
 * The web as venture districts around Jarvis. Each venture is one box: its lead row on the side
 * facing Jarvis, the rest of its people in rows behind. Boxes are pushed out from Jarvis along a ray
 * until they touch nothing, so no bubble or district ever overlaps another. Of several arrangements
 * the one that fills the given aspect best wins, which keeps the type large when the whole web is fitted.
 */
export function layoutWeb(agents: AgentLive[], opts: LayoutOpts): WebLayout {
  const S = opts.compact ? SIZES.compact : SIZES.wide;
  const pos: Record<string, NodePos> = {};
  const jarvis = agents.find((a) => a.id === "jarvis");

  // Bubble sizes.
  for (const a of agents) {
    if (a.id === "jarvis") {
      const sub = opts.compact ? undefined : clip(a.short, 26);
      const w = Math.max(opts.measure(a.name, NAME_FONT(S.jarvisFs)), sub ? opts.measure(sub, SUB_FONT(S.subFs)) : 0) + S.padX * 3;
      pos[a.id] = { x: 0, y: 0, w: Math.max(w, opts.compact ? 104 : 150), h: S.jarvisH, fs: S.jarvisFs, sub, subFs: S.subFs };
      continue;
    }
    const head = a.layer <= 1;
    const fs = head ? S.headFs : S.leafFs;
    const sub = head && !opts.compact ? clip(a.short, 24) : undefined;
    const tw = Math.max(opts.measure(a.name, NAME_FONT(fs)), sub ? opts.measure(sub, SUB_FONT(S.subFs)) : 0);
    const h = head ? S.headH : S.leafH;
    pos[a.id] = { x: 0, y: 0, w: Math.ceil(Math.max(tw + S.padX * 2 + 4, h * 1.7)), h, fs, sub, subFs: S.subFs };
  }

  // Tree order: Jarvis's leads in registry order, each followed by their team.
  const kids = (id: string) => agents.filter((a) => a.parent === id && a.id !== "jarvis");
  const order: AgentLive[] = [];
  const seen = new Set<string>();
  const walk = (a: AgentLive) => { if (seen.has(a.id)) return; seen.add(a.id); order.push(a); kids(a.id).forEach(walk); };
  agents.filter((a) => a.id !== "jarvis" && (a.parent === "jarvis" || !a.parent || !agents.some((p) => p.id === a.parent))).forEach(walk);
  agents.filter((a) => a.id !== "jarvis").forEach(walk);

  // One district per venture, in the order its first member appears.
  const groups = new Map<VentureId, AgentLive[]>();
  for (const a of order) { const g = groups.get(a.venture) ?? []; g.push(a); groups.set(a.venture, g); }

  const build = (venture: VentureId, members: AgentLive[], aspect: number): Built => {
    const label = opts.ventureLabel(venture);
    const labelW = opts.measure(label, LABEL_FONT(S.labelFs)) + label.length * S.labelFs * 0.14 + 12;
    const minLayer = Math.min(...members.map((m) => m.layer));
    const depths = new Map<number, AgentLive[]>();
    for (const m of members) { const d = m.layer - minLayer; depths.set(d, [...(depths.get(d) ?? []), m]); }
    const widest = Math.max(...members.map((m) => pos[m.id]!.w));
    const total = members.reduce((s, m) => s + pos[m.id]!.w + S.gapX, 0);
    let best: Built | null = null; let bestScore = Infinity;
    for (let maxW = widest; maxW <= total + 1; maxW += Math.max(24, widest / 3)) {
      const rows: AgentLive[][] = [];
      for (const d of [...depths.keys()].sort((x, y) => x - y)) {
        let row: AgentLive[] = []; let rw = 0;
        for (const m of depths.get(d)!) {
          const w = pos[m.id]!.w;
          if (row.length && rw + S.gapX + w > maxW) { rows.push(row); row = []; rw = 0; }
          rw += (row.length ? S.gapX : 0) + w; row.push(m);
        }
        if (row.length) rows.push(row);
      }
      const rowW = rows.map((r) => r.reduce((s, m) => s + pos[m.id]!.w, 0) + S.gapX * (r.length - 1));
      const rowH = rows.map((r) => Math.max(...r.map((m) => pos[m.id]!.h)));
      const innerW = Math.max(...rowW, labelW);
      const w = innerW + S.pad * 2;
      const h = S.labelH + rowH.reduce((s, x) => s + x, 0) + S.gapY * (rows.length - 1) + S.pad;
      const placed = rows.map((r, i) => {
        let x = -rowW[i]! / 2;
        const top = -h / 2 + S.labelH + rowH.slice(0, i).reduce((s, v) => s + v + S.gapY, 0);
        return r.map((m) => { const p = pos[m.id]!; const dx = x + p.w / 2; x += p.w + S.gapX; return { id: m.id, dx, dy: top + rowH[i]! / 2 }; });
      });
      const score = Math.abs(Math.log(w / h / aspect)) + (w * h) / 4e6;
      if (score < bestScore) { bestScore = score; best = { venture, label, labelFs: S.labelFs, w, h, rows: placed }; }
    }
    return best!;
  };

  const jw = jarvis ? pos.jarvis!.w : 0, jh = jarvis ? pos.jarvis!.h : 0;
  const hit = (a: Box, b: Box, m: number) => Math.abs(a.x - b.x) * 2 < a.w + b.w + m * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + m * 2;

  const arrange = (boxAspect: number, stretch: number, turn: number) => {
    const built = [...groups.entries()].map(([v, m]) => build(v, m, boxAspect));
    const weight = built.map((b) => b.w + b.h);
    const sum = weight.reduce((s, x) => s + x, 0);
    let acc = 0;
    const dirs = built.map((_, i) => { const t = ((acc + weight[i]! / 2) / sum + turn) * Math.PI * 2; acc += weight[i]!; return { dx: Math.sin(t) * stretch, dy: -Math.cos(t) / stretch }; });
    const centre: Box = { x: 0, y: 0, w: jw, h: jh };
    const boxes: (Box | null)[] = built.map(() => null);
    const pushOut = (i: number) => {
      const b = built[i]!; const d = dirs[i]!;
      const step = 6 / Math.hypot(d.dx, d.dy);
      for (let t = 0; t < 4000; t += step) {
        const c: Box = { x: d.dx * t, y: d.dy * t, w: b.w, h: b.h };
        if (jarvis && hit(c, centre, S.gap)) continue;
        if (boxes.some((o, j) => j !== i && o && hit(c, o, S.gap))) continue;
        return c;
      }
      return { x: d.dx * 4000, y: d.dy * 4000, w: b.w, h: b.h };
    };
    built.forEach((_, i) => { boxes[i] = pushOut(i); });
    // Pull each district back in as far as the others now allow.
    for (let round = 0; round < 3; round++) built.forEach((_, i) => { boxes[i] = null; boxes[i] = pushOut(i); });
    // Then let them settle towards Jarvis one axis at a time, closing the gaps the rays leave.
    const free = (c: Box, i: number) => !(jarvis && hit(c, centre, S.gap)) && !boxes.some((o, j) => j !== i && o && hit(c, o, S.gap));
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      boxes.forEach((b, i) => {
        for (const axis of ["y", "x"] as const) {
          while (Math.abs(b![axis]) >= 3) {
            const c = { ...b!, [axis]: b![axis] - Math.sign(b![axis]) * 3 };
            if (!free(c, i)) break;
            b![axis] = c[axis]; moved = true;
          }
        }
      });
      if (!moved) break;
    }
    const all = [...(jarvis ? [centre] : []), ...(boxes as Box[])];
    const x0 = Math.min(...all.map((b) => b.x - b.w / 2)), x1 = Math.max(...all.map((b) => b.x + b.w / 2));
    const y0 = Math.min(...all.map((b) => b.y - b.h / 2)), y1 = Math.max(...all.map((b) => b.y + b.h / 2));
    // How large the web can be drawn in the space it has: bigger is better.
    const fill = Math.min(opts.aspect / (x1 - x0), 1 / (y1 - y0));
    return { built, boxes: boxes as Box[], bounds: { x0, y0, x1, y1 }, fill };
  };

  let best: ReturnType<typeof arrange> | null = null;
  if (groups.size) {
    const base = Math.sqrt(opts.aspect);
    for (const boxAspect of opts.compact ? [0.7, 1, 1.4, 1.9] : [1, 1.4, 1.9, 2.6])
      for (const stretch of [base * 0.75, base, base * 1.3])
        for (const turn of [0, 0.03, -0.03]) {
          const r = arrange(boxAspect, stretch, turn);
          if (!best || r.fill > best.fill) best = r;
        }
  }

  const clusters: ClusterPos[] = [];
  if (best) {
    best.built.forEach((b, i) => {
      const box = best!.boxes[i]!;
      // Districts above Jarvis keep their lead on the row nearest him.
      const flip = box.y < -jh / 2 && b.rows.length > 1;
      const nodes = b.rows.flat();
      // Mirror the rows inside the member area; the label strip stays on top.
      const top = Math.min(...nodes.map((n) => n.dy - pos[n.id]!.h / 2));
      const bottom = Math.max(...nodes.map((n) => n.dy + pos[n.id]!.h / 2));
      for (const n of nodes) { const p = pos[n.id]!; p.x = box.x + n.dx; p.y = box.y + (flip ? top + bottom - n.dy : n.dy); }
      clusters.push({ venture: b.venture, label: b.label, labelFs: b.labelFs, x: box.x, y: box.y, w: box.w, h: box.h, labelY: box.y - box.h / 2 + S.labelH * 0.68 });
    });
  }
  const bounds = best ? best.bounds : { x0: -jw / 2, y0: -jh / 2, x1: jw / 2, y1: jh / 2 };
  return { pos, clusters, bounds };
}
