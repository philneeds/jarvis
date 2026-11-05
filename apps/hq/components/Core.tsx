"use client";

import { useEffect, useRef } from "react";

export type CoreState = "idle" | "listening" | "thinking" | "speaking" | "paused";

/**
 * The Jarvis core: a layered holographic HUD drawn on canvas. Rings turn at different speeds, the inner
 * waveform moves with his voice (level 0..1), the ring glows with the mic when he's listening, and the whole
 * thing spins up when he's thinking. Colors follow the HQ palette; paused turns it red.
 */
export function Core({ state = "idle", level = 0, size = 260, label }: { state?: CoreState; level?: number; size?: number; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  const stateRef = useRef(state);
  levelRef.current = level;
  stateRef.current = state;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr; canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, t0 = performance.now(), smooth = 0, running = true;
    const cx = size / 2, cy = size / 2, R = size / 2 - 4;

    const palette = () => {
      const s = stateRef.current;
      return s === "paused" ? { a: "#FF4F6A", b: "#FF8FA0", core: "#FFC9D2" }
        : s === "listening" ? { a: "#FFC266", b: "#FFD27A", core: "#FFF3D6" }
        : s === "thinking" ? { a: "#9ED4FF", b: "#CFE9FF", core: "#FFFFFF" }
        : { a: "#7CC4FF", b: "#A6D8FF", core: "#FFFFFF" };
    };
    const arc = (r: number, from: number, to: number, w: number, color: string, glow = 0) => {
      ctx.beginPath(); ctx.arc(cx, cy, r, from, to); ctx.lineWidth = w; ctx.strokeStyle = color;
      ctx.shadowBlur = glow; ctx.shadowColor = color; ctx.stroke(); ctx.shadowBlur = 0;
    };

    const draw = (now: number) => {
      if (!running) return;
      const t = (now - t0) / 1000;
      const s = stateRef.current;
      const speed = s === "thinking" ? 2.6 : s === "speaking" ? 1.4 : 1;
      const target = levelRef.current;
      smooth += (target - smooth) * 0.25;
      const lvl = s === "idle" || s === "paused" ? 0.08 + 0.05 * Math.sin(t * 1.3) : Math.max(0.1, smooth);
      const p = palette();
      ctx.clearRect(0, 0, size, size);

      // Outer tick ring: 72 ticks, every 6th longer; slow clockwise.
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(reduce ? 0 : t * 0.08 * speed);
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2, long = i % 6 === 0;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * (R - (long ? 12 : 6)), Math.sin(a) * (R - (long ? 12 : 6))); ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        ctx.lineWidth = long ? 2 : 1; ctx.strokeStyle = long ? p.a : `${p.a}88`; ctx.stroke();
      }
      ctx.restore();
      arc(R - 14, 0, Math.PI * 2, 1, `${p.a}55`);

      // Segmented data ring, counter-clockwise: dashes of pseudo-random lengths.
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(reduce ? 0 : -t * 0.15 * speed); ctx.translate(-cx, -cy);
      let a0 = 0;
      for (let i = 0; i < 24; i++) {
        const len = 0.12 + 0.18 * Math.abs(Math.sin(i * 12.9898)), gap = 0.06;
        const on = ((i + Math.floor(t * 2 * speed)) % 7) !== 0;
        if (on) arc(R - 24, a0, a0 + len, 3, i % 5 === 0 ? p.b : `${p.a}AA`, i % 5 === 0 ? 6 : 0);
        a0 += len + gap;
      }
      ctx.restore();

      // Three sweeping arcs at different speeds.
      const sweeps: [number, number, number][] = [[R - 40, 0.9, 0.42], [R - 40, -0.6, 0.18], [R - 52, 0.35, 0.72]];
      sweeps.forEach(([r, v, span], i) => {
        const start = reduce ? i * 2 : t * v * speed + i * 2;
        arc(r, start, start + span * Math.PI * 2, i === 2 ? 1.5 : 3, i === 2 ? `${p.a}99` : p.a, i === 2 ? 0 : 10);
      });

      // Breathing dashed ring.
      ctx.setLineDash([3, 6]); arc(R - 66 + Math.sin(t * 1.2) * 2, 0, Math.PI * 2, 1, `${p.b}99`); ctx.setLineDash([]);

      // Core: glow + dotted sphere + voice waveform.
      const cr = R - 86;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr + 30);
      g.addColorStop(0, `${p.core}F2`); g.addColorStop(0.18, `${p.a}99`); g.addColorStop(0.55, `${p.a}22`); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, cr + 30, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = `${p.core}CC`;
      for (let y = -cr; y <= cr; y += 7) for (let x = -cr; x <= cr; x += 7) {
        const d = Math.hypot(x, y) / cr; if (d > 1) continue;
        const rr = 0.9 + (1 - d) * 0.9 * (0.6 + lvl); ctx.beginPath(); ctx.arc(cx + x, cy + y, rr, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      // Waveform ring: radius modulated by a few sines, amplitude from the voice level.
      const amp = 2 + lvl * 16;
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * Math.PI * 2;
        const m = Math.sin(a * 6 + t * 7) * 0.5 + Math.sin(a * 11 - t * 9) * 0.3 + Math.sin(a * 3 + t * 3) * 0.2;
        const r = cr + 4 + m * amp;
        i === 0 ? ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.closePath(); ctx.lineWidth = 1.5; ctx.strokeStyle = p.b; ctx.shadowBlur = 12; ctx.shadowColor = p.b; ctx.stroke(); ctx.shadowBlur = 0;
      // No made-up readouts on the ring: fake numbers make the real ones elsewhere harder to believe.

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const vis = () => { if (document.hidden) { running = false; cancelAnimationFrame(raf); } else if (!running) { running = true; t0 = performance.now() - 1; raf = requestAnimationFrame(draw); } };
    document.addEventListener("visibilitychange", vis);
    return () => { running = false; cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", vis); };
  }, [size]);

  // The state word sits under the ring, clear of the arcs.
  return (
    <div className="flex-none flex flex-col items-center gap-2" style={{ width: size }} aria-hidden="true">
      <canvas ref={ref} style={{ width: size, height: size }} />
      {label && <span className="text-[11px] leading-none tracking-[0.22em] whitespace-nowrap" style={{ color: "var(--ink-strong)", textShadow: "0 0 8px rgba(124,196,255,0.9)" }}>{label}</span>}
    </div>
  );
}
