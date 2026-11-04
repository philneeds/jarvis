"use client";

import { useEffect, useRef } from "react";

/**
 * Double-clap detector that is fussy about what counts as a clap.
 * A clap is: a sharp onset from a quiet room (peak well above the recent level), very short (the level falls
 * back to a quarter of the peak within ~120 ms), and broadband (plenty of energy above 2 kHz, which speech,
 * music and most thuds lack). Two such bursts 150–650 ms apart, of similar strength, with nothing loud in
 * between, count as the signal. Anything else is ignored.
 */
export type ClapSensitivity = "low" | "normal" | "high";

const PROFILES: Record<ClapSensitivity, { peak: number; ratio: number; hf: number }> = {
  low: { peak: 0.55, ratio: 6, hf: 0.45 },
  normal: { peak: 0.4, ratio: 5, hf: 0.38 },
  high: { peak: 0.28, ratio: 4, hf: 0.3 },
};

export function useClap(enabled: boolean, onClap: () => void, opts: { sensitivity?: ClapSensitivity } = {}) {
  const cb = useRef(onClap);
  cb.current = onClap;
  const sens = opts.sensitivity ?? "normal";
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.mediaDevices) return;
    const P = PROFILES[sens];
    let ctx: AudioContext | null = null, stream: MediaStream | null = null, raf = 0, stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0; src.connect(an);
        const time = new Uint8Array(an.fftSize), freq = new Uint8Array(an.frequencyBinCount);
        const binHz = ctx.sampleRate / an.fftSize;
        const hfFrom = Math.floor(2000 / binHz);
        let floor = 0.02;                       // slow-moving level of the room
        let onset: { at: number; peak: number } | null = null; // a burst being checked for shortness
        let claps: { at: number; peak: number }[] = [];
        let loudInGap = false, cooldownUntil = 0;
        const tick = () => {
          if (stop) return;
          an.getByteTimeDomainData(time);
          let peak = 0, sum = 0;
          for (const v of time) { const d = Math.abs(v - 128) / 128; if (d > peak) peak = d; sum += d * d; }
          const rms = Math.sqrt(sum / time.length);
          const now = performance.now();

          if (onset) {
            // Shortness check: a clap collapses fast; a voice, a door or a TV does not.
            if (now - onset.at >= 120) {
              const short = rms < onset.peak * 0.25;
              const c = onset; onset = null;
              if (short) {
                if (claps.length === 1 && !loudInGap && c.at - claps[0]!.at >= 150 && c.at - claps[0]!.at <= 650 && c.peak > claps[0]!.peak * 0.5 && c.peak < claps[0]!.peak * 2) {
                  claps = []; cooldownUntil = now + 2000; cb.current();
                } else { claps = [c]; loudInGap = false; }
              }
            } else if (rms > onset.peak * 0.6 && now - onset.at > 40) {
              onset = null; // still loud 40 ms in: not a clap
            }
          } else if (now > cooldownUntil && peak > P.peak && peak > floor * P.ratio) {
            an.getByteFrequencyData(freq);
            let total = 0, hf = 0;
            for (let i = 1; i < freq.length; i++) { total += freq[i]!; if (i >= hfFrom) hf += freq[i]!; }
            if (total > 0 && hf / total >= P.hf) onset = { at: now, peak };
            else if (claps.length) loudInGap = true;
          } else if (claps.length && rms > floor * 3 && now - claps[0]!.at > 60) {
            loudInGap = true; // talking or noise between the two claps: not a double clap
          }
          if (claps.length && now - claps[0]!.at > 650) { claps = []; loudInGap = false; }
          if (!onset) floor = floor * 0.995 + rms * 0.005;
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* no mic: no clap */ }
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); void ctx?.close(); };
  }, [enabled, sens]);
}
