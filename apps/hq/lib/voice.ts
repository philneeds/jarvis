"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice for Jarvis.
 *
 * Listening: the browser's own speech recognition (Chrome, Safari). It decides when Phil has finished a sentence
 * from the words, not the volume, which is what made the first version feel right. It uses the computer's input
 * device as set in the system's sound settings. A level meter on the same mic drives the orb.
 *
 * Speaking: the reply is split into sentences; the first is fetched and played while the next is already being
 * generated, so the first words come fast. Stop words cut him off.
 */
type Rec = { start(): void; stop(): void; abort(): void; onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null; lang: string; interimResults: boolean; continuous: boolean };

function recognizer(): Rec | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return C ? new C() : null;
}

export function stripForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[Approval queued: ([^\]]+)\]/g, "Approval queued: $1.")
    .replace(/^#{1,6}\s+/gm, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link").replace(/^\s*[-*•]\s+/gm, "").replace(/\s+/g, " ").trim();
}

/** Sentences grouped into chunks of a comfortable length, the first one short so speech starts fast. */
export function chunkForSpeech(text: string, first = 110, rest = 240): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const limit = out.length === 0 ? first : rest;
    if (cur && (cur + " " + s).length > limit) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

export function pickVoice(): SpeechSynthesisVoice | undefined {
  if (typeof speechSynthesis === "undefined") return undefined;
  const voices = speechSynthesis.getVoices();
  const want = ["Daniel", "Google UK English Male", "Microsoft Ryan", "Arthur", "Oliver", "en-GB"];
  for (const w of want) { const v = voices.find((x) => x.name.includes(w) || (w === "en-GB" && x.lang === "en-GB")); if (v) return v; }
  return voices.find((v) => v.lang.startsWith("en")) ?? voices[0];
}


/** A short two-tone chime so he knows the mic is open without waiting for speech. */
function chime(ctx: AudioContext, up = true) {
  const t = ctx.currentTime;
  for (const [i, f] of (up ? [660, 880] : [880, 660]).entries()) {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "sine"; o.frequency.value = f; g.gain.value = 0.0001;
    o.connect(g).connect(ctx.destination);
    g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.12);
    o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.13);
  }
}


/**
 * How long HQ waits after Phil stops talking before it takes the turn. The browser's own end-of-speech cut-off is
 * about a second and not adjustable, so HQ listens continuously and ends the turn itself. Remembered per device.
 */
export type PauseChoice = "short" | "normal" | "long" | "longer";
export const PAUSE_MS: Record<PauseChoice, number> = { short: 1500, normal: 2500, long: 4000, longer: 6000 };
export const PAUSE_LABEL: Record<PauseChoice, string> = { short: "pause 1.5s", normal: "pause 2.5s", long: "pause 4s", longer: "pause 6s" };
export function readPause(): PauseChoice {
  try { const v = localStorage.getItem("hq.pause"); if (v === "short" || v === "normal" || v === "long" || v === "longer") return v; } catch { /* ignore */ }
  return "normal";
}
export function savePause(p: PauseChoice) { try { localStorage.setItem("hq.pause", p); } catch { /* ignore */ } }

export function useVoice(opts: { onHeard: (text: string) => void | Promise<void> }) {
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [hearing, setHearing] = useState(false);      // speech detected right now
  const [level, setLevel] = useState(0);
  const [interim, setInterim] = useState("");
  const [serverTts, setServerTts] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<Rec | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const levelRaf = useRef(0);
  const abortListen = useRef<(() => void) | null>(null);
  const forceEnd = useRef<(() => void) | null>(null);
  const onHeardRef = useRef(opts.onHeard);
  onHeardRef.current = opts.onHeard;

  useEffect(() => {
    fetch("/api/tts/status", { credentials: "include" }).then((r) => r.json()).then((j: { available?: boolean; lastFailure?: { detail: string } }) => {
      setServerTts(!!j.available);
      if (j.lastFailure) setError(`${j.lastFailure.detail}. Using this device's voice for now.`);
    }).catch(() => setServerTts(false));
  }, []);

  const ctx = () => ctxRef.current ?? (ctxRef.current = new AudioContext());

  /** The system's default mic, opened once per conversation for the level meter. */
  const openMic = useCallback(async (): Promise<MediaStream> => {
    if (micStream.current?.active) return micStream.current;
    micStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    return micStream.current;
  }, []);
  const closeMic = useCallback(() => { micStream.current?.getTracks().forEach((t) => t.stop()); micStream.current = null; }, []);

  const meter = useCallback((node: AudioNode, c: AudioContext) => {
    const an = c.createAnalyser(); an.fftSize = 512; node.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const tick = () => { an.getByteTimeDomainData(buf); let sum = 0; for (const v of buf) { const d = (v - 128) / 128; sum += d * d; } setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4)); levelRaf.current = requestAnimationFrame(tick); };
    tick();
    return () => { cancelAnimationFrame(levelRaf.current); an.disconnect(); setLevel(0); };
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ""; audioRef.current = null; }
    cancelAnimationFrame(levelRaf.current); setLevel(0); setSpeaking(false);
  }, []);

  /**
   * While he speaks, a narrow listener watches for stop words only: "stop", "hold on", "wait", "enough", "shut up",
   * or "Jarvis" + any of those. A stop word that also occurs in what he is saying only counts with "Jarvis" in
   * front of it, so he can't cut himself off. Everything else said in the room is ignored.
   */
  const bargeIn = useCallback((spoken: string, onStop: () => void): (() => void) => {
    const r = recognizer();
    if (!r) return () => undefined;
    const own = new Set((spoken.toLowerCase().match(/\b(stop|wait|enough|hold on|shut up)\b/g) ?? []));
    let stopped = false;
    const check = (heard: string) => {
      const h = heard.toLowerCase();
      if (/\bjarvis\b[,\s]*(stop|wait|enough|hold on|shut up|quiet)\b/.test(h)) return true;
      const m = h.match(/\b(stop|wait|enough|hold on|shut up)\b/);
      return !!m && !own.has(m[1]!);
    };
    r.lang = "en-US"; r.interimResults = true; r.continuous = true;
    r.onresult = (e) => { let s = ""; for (let i = e.resultIndex; i < e.results.length; i++) s += e.results[i]![0]!.transcript + " "; if (check(s)) { stopped = true; try { r.abort(); } catch { /* fine */ } onStop(); } };
    r.onend = () => { if (!stopped) { try { r.start(); } catch { /* done */ } } };
    r.onerror = () => undefined;
    try { r.start(); } catch { /* no mic */ }
    return () => { stopped = true; try { r.abort(); } catch { /* fine */ } };
  }, []);

  const fetchTts = useCallback(async (text: string): Promise<Blob | null> => {
    const res = await fetch("/api/tts", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (res.ok) return res.blob();
    // Say why the voice changed instead of switching to the browser's voice silently.
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setError(`${(j.error ?? `voice failed: ${res.status}`).replace(/^voice failed: /, "")}. Using this device's voice for now.`);
    return null;
  }, []);

  const playBlob = useCallback(async (blob: Blob) => {
    const audio = new Audio(URL.createObjectURL(blob)); audioRef.current = audio;
    // ElevenLabs tops out at 1.2x; Phil wants 1.5x, so the rest is playback speed (pitch is kept).
    audio.playbackRate = Number(process.env.NEXT_PUBLIC_VOICE_PLAYBACK ?? 1.25); audio.preservesPitch = true;
    const c = ctx();
    const src = c.createMediaElementSource(audio); src.connect(c.destination);
    const stop = meter(src, c);
    await new Promise<void>((resolve) => { audio.onended = () => resolve(); audio.onerror = () => resolve(); audio.onpause = () => resolve(); void audio.play().catch(() => resolve()); });
    stop(); src.disconnect(); URL.revokeObjectURL(audio.src);
  }, [meter]);

  /** Speak. With bargeIn, stop words cut him off; resolves true if he was interrupted. */
  const speak = useCallback(async (markdown: string, opts: { bargeIn?: boolean } = {}): Promise<boolean> => {
    const text = stripForSpeech(markdown).slice(0, 1800);
    if (!text) return false;
    stopSpeaking();
    setSpeaking(true);
    let interrupted = false;
    const endBarge = opts.bargeIn ? bargeIn(text, () => { interrupted = true; stopSpeaking(); }) : () => undefined;
    try {
      if (serverTts) {
        // Pipeline: fetch chunk n+1 while chunk n plays, so the first words land fast.
        const chunks = chunkForSpeech(text);
        let next = fetchTts(chunks[0]!);
        let ok = true;
        for (let i = 0; i < chunks.length && !interrupted; i++) {
          const blob = await next;
          if (!blob) { ok = i > 0; break; }
          if (i + 1 < chunks.length) next = fetchTts(chunks[i + 1]!);
          if (interrupted) break;
          await playBlob(blob);
        }
        if (ok) return interrupted;
      }
      if (typeof speechSynthesis === "undefined") { setError("This browser can't speak."); return false; }
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        const v = pickVoice(); if (v) u.voice = v;
        u.rate = 1.5; u.pitch = 0.9;
        let pulse = 0;
        const timer = setInterval(() => { pulse = (pulse + 1) % 6; setLevel(0.25 + 0.35 * Math.abs(Math.sin(pulse))); }, 120);
        u.onboundary = () => setLevel(0.5 + Math.random() * 0.4);
        u.onend = () => { clearInterval(timer); resolve(); };
        u.onerror = () => { clearInterval(timer); resolve(); };
        speechSynthesis.speak(u);
      });
      return interrupted;
    } finally {
      endBarge();
      setLevel(0); setSpeaking(false);
    }
  }, [serverTts, stopSpeaking, meter, bargeIn, fetchTts, playBlob]);

  const stopListening = useCallback(() => {
    abortListen.current?.(); abortListen.current = null;
    try { recRef.current?.abort(); } catch { /* fine */ }
    recRef.current = null;
    cancelAnimationFrame(levelRaf.current); setLevel(0); setListening(false); setHearing(false); setInterim("");
  }, []);

  /**
   * Listen for one utterance; resolves with the text ("" if nothing was heard, or nothing within timeoutMs).
   * The recognizer ends the turn itself when Phil stops talking; "Send now" asks it to finish early.
   */
  const listen = useCallback(async (opts: { timeoutMs?: number; pauseMs?: number } = {}): Promise<string> => {
    const r = recognizer();
    if (!r) { setError("Voice input isn't available in this browser. Chrome or Safari work."); return ""; }
    stopSpeaking();
    setError(undefined); setInterim("");
    // The orb's level meter. Decoration only: listening works without it.
    let stopMeter = () => undefined as void;
    try {
      const stream = await openMic();
      const c = ctx();
      if (c.state === "suspended") await c.resume().catch(() => undefined);
      const src = c.createMediaStreamSource(stream);
      const stop = meter(src, c);
      stopMeter = () => { stop(); src.disconnect(); };
    } catch { /* no meter */ }
    return new Promise<string>((resolve) => {
      // Continuous: the browser keeps listening through Phil's pauses; HQ ends the turn after the chosen silence.
      recRef.current = r; r.lang = "en-US"; r.interimResults = true; r.continuous = true;
      let finalText = "", latest = "", done = false, heard = false;
      let silence: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(timer); clearTimeout(silence); stopMeter(); forceEnd.current = null; abortListen.current = null; recRef.current = null;
        setListening(false); setHearing(false); setInterim("");
        resolve((finalText || latest).trim());
      };
      // The reply window: if nobody has started talking by then, close the mic.
      const timer = opts.timeoutMs ? setTimeout(() => { if (!heard) { try { r.abort(); } catch { /* fine */ } finish(); } }, opts.timeoutMs) : undefined;
      const pauseMs = opts.pauseMs ?? PAUSE_MS[readPause()];
      r.onresult = (e) => {
        heard = true; setHearing(true);
        let s = ""; for (let i = 0; i < e.results.length; i++) s += e.results[i]![0]!.transcript;
        latest = s; setInterim(s);
        if (e.results[e.results.length - 1]?.isFinal) finalText = s;
        // Every word restarts the clock; the turn ends only after pauseMs of nothing.
        clearTimeout(silence);
        silence = setTimeout(() => { try { r.stop(); } catch { finish(); } }, pauseMs);
      };
      r.onend = finish;
      r.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") setError(`Mic: ${e.error}`); finish(); };
      forceEnd.current = () => { try { r.stop(); } catch { finish(); } }; // the recognizer hands back what it has, then ends
      abortListen.current = () => { try { r.abort(); } catch { /* fine */ } finish(); };
      setListening(true);
      try { r.start(); } catch { finish(); }
    });
  }, [openMic, meter, stopSpeaking]);

  const [conversation, setConversation] = useState(false);
  const convRef = useRef(false);
  const loop = useCallback(async () => {
    let empty = 0;
    while (convRef.current) {
      const t = performance.now();
      const heard = await listen();
      if (!convRef.current) break;
      if (!heard) {
        // Returning at once with nothing means it can't hear at all (mic refused, no recognizer); stop rather than spin.
        empty = performance.now() - t < 300 ? empty + 1 : 0;
        if (empty >= 3) { convRef.current = false; setConversation(false); closeMic(); break; }
        continue;
      }
      empty = 0;
      if (/^(stop|that's all|that is all|goodbye|exit|thanks,? that's all)\b/i.test(heard)) { convRef.current = false; setConversation(false); chime(ctx(), false); closeMic(); break; }
      await onHeardRef.current(heard);
    }
  }, [listen, closeMic]);

  /** Start a conversation: open the mic, chime, listen. No spoken "Listening." to wait through. */
  const startConversation = useCallback(async () => {
    convRef.current = true; setConversation(true); setError(undefined);
    try { await openMic(); chime(ctx(), true); } catch { setError("Microphone not available. Allow the mic for this site, and check the input device in your computer's sound settings."); convRef.current = false; setConversation(false); return; }
    void loop();
  }, [loop, openMic]);
  /** End the current turn now and send what was said. */
  const finishTurn = useCallback(() => { forceEnd.current?.(); }, []);
  const endConversation = useCallback(() => { convRef.current = false; setConversation(false); stopListening(); stopSpeaking(); closeMic(); }, [stopListening, stopSpeaking, closeMic]);

  useEffect(() => () => { convRef.current = false; stopListening(); stopSpeaking(); closeMic(); }, [stopListening, stopSpeaking, closeMic]);

  return { speak, stopSpeaking, listen, stopListening, speaking, listening, hearing, level, interim, serverTts, error, conversation, startConversation, endConversation, finishTurn };
}
