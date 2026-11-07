"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Double-clap detector that is fussy about what counts as a clap.
 * A clap is: a sharp onset from a quiet room (peak well above the recent level), very short (the level falls
 * back to a quarter of the peak within ~120 ms), and broadband (plenty of energy above 2 kHz, which speech,
 * music and most thuds lack). Two such bursts 150–650 ms apart, of similar strength, with nothing loud in
 * between, count as the signal. Anything else is ignored.
 *
 * Arming: phones only hand out the microphone, and only run an AudioContext, from inside a tap. primeClap() is
 * called in the Start tap itself, before anything is awaited, and the detector takes over that mic and context.
 * Coming back from the background (screen off, another app), the context is resumed and a dead mic re-asked for;
 * when the browser refuses without a tap, the page shows "Arm clap" and rearm() does it from that tap.
 */
export type ClapSensitivity = "low" | "normal" | "high";
export interface ClapStatus { armed: boolean; needsTap: boolean; rearm(): void }

const PROFILES: Record<ClapSensitivity, { peak: number; ratio: number; hf: number }> = {
  low: { peak: 0.55, ratio: 6, hf: 0.45 },
  normal: { peak: 0.4, ratio: 5, hf: 0.38 },
  high: { peak: 0.28, ratio: 4, hf: 0.3 },
};
const MIC: MediaStreamConstraints = { audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } };

type Primed = { stream: MediaStream; ctx: AudioContext };
let primed: Promise<Primed> | null = null;

/** Call synchronously inside a user tap: opens the mic and an AudioContext while the browser still allows it. */
export function primeClap(): void {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  const ctx = new AudioContext();
  const p = navigator.mediaDevices.getUserMedia(MIC).then(async (stream) => { await ctx.resume().catch(() => undefined); return { stream, ctx }; });
  p.catch(() => { void ctx.close().catch(() => undefined); if (primed === p) primed = null; });
  primed = p;
}

export function useClap(enabled: boolean, onClap: () => void, opts: { sensitivity?: ClapSensitivity } = {}): ClapStatus {
  const cb = useRef(onClap);
  cb.current = onClap;
  const sens = opts.sensitivity ?? "normal";
  const [armed, setArmed] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [gen, setGen] = useState(0);
  const rearm = useCallback(() => { primeClap(); setNeedsTap(false); setGen((g) => g + 1); }, []);

  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.mediaDevices) { setArmed(false); return; }
    const P = PROFILES[sens];
    let ctx: AudioContext | null = null, stream: MediaStream | null = null, raf = 0, stop = false, source: MediaStreamAudioSourceNode | null = null, an: AnalyserNode | null = null;
    let floor = 0.02;                       // slow-moving level of the room
    let onset: { at: number; peak: number } | null = null; // a burst being checked for shortness
    let claps: { at: number; peak: number }[] = [];
    let loudInGap = false, cooldownUntil = 0;
    const time = new Uint8Array(1024), freq = new Uint8Array(512);
    let hfFrom = 0;

    const tick = () => {
      if (stop || !an) return;
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

    /** Wire the mic into the analyser; a mic the browser took away is asked for again. */
    const attach = async (fresh?: Primed) => {
      try {
        if (fresh) { stream = fresh.stream; ctx = fresh.ctx; }
        else {
          stream = await navigator.mediaDevices.getUserMedia(MIC);
          ctx ??= new AudioContext();
        }
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        await ctx.resume().catch(() => undefined);
        source?.disconnect();
        source = ctx.createMediaStreamSource(stream);
        an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0; source.connect(an);
        hfFrom = Math.floor(2000 / (ctx.sampleRate / an.fftSize));
        setArmed(true); setNeedsTap(false);
        cancelAnimationFrame(raf); tick();
      } catch {
        setArmed(false); setNeedsTap(true); // no mic without a tap: the page offers "Arm clap"
      }
    };
    const live = () => !!stream && stream.getAudioTracks().some((t) => t.readyState === "live" && t.enabled);
    // Back from the background: the context is suspended and, on phones, the mic track is often ended. Fix both.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || stop) return;
      void ctx?.resume().catch(() => undefined);
      if (!live()) void attach();
    };
    document.addEventListener("visibilitychange", onVisible);
    const p = primed; primed = null;
    void (p ? p.then((fresh) => attach(fresh), () => attach()) : attach());
    return () => {
      stop = true; cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisible);
      stream?.getTracks().forEach((t) => t.stop()); void ctx?.close().catch(() => undefined);
      setArmed(false);
    };
  }, [enabled, sens, gen]);

  return { armed, needsTap, rearm };
}
