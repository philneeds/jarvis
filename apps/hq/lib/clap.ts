"use client";

import { useEffect, useRef } from "react";

/**
 * Double-clap detector: two sharp peaks 120–700 ms apart, each well above the room's running average.
 * Runs on its own mic stream so it works with or without the wake-word engine.
 */
export function useClap(enabled: boolean, onClap: () => void, opts: { threshold?: number } = {}) {
  const cb = useRef(onClap);
  cb.current = onClap;
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.mediaDevices) return;
    let ctx: AudioContext | null = null, stream: MediaStream | null = null, raf = 0, stop = false;
    const threshold = opts.threshold ?? 0.35;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
        const buf = new Uint8Array(an.fftSize);
        let avg = 0.02, last = 0, firstAt = 0, cooldown = 0;
        const tick = () => {
          if (stop) return;
          an.getByteTimeDomainData(buf);
          let peak = 0; for (const v of buf) { const d = Math.abs(v - 128) / 128; if (d > peak) peak = d; }
          const now = performance.now();
          const sharp = peak > threshold && peak > avg * 4 && now - last > 120;
          if (sharp && now > cooldown) {
            if (firstAt && now - firstAt < 700) { firstAt = 0; cooldown = now + 1500; cb.current(); }
            else firstAt = now;
            last = now;
          }
          if (firstAt && now - firstAt > 700) firstAt = 0;
          avg = avg * 0.98 + peak * 0.02;
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* no mic: no clap */ }
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); void ctx?.close(); };
  }, [enabled, opts.threshold]);
}
