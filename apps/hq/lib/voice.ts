"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice for Jarvis. Speaking: the server's TTS (ElevenLabs, when a key is set) with a live level from an
 * analyser, else the browser's own voices. Listening: the Web Speech API with a mic level from an analyser.
 * Conversation mode chains them: speak the reply, then listen, then send what was heard.
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

export function pickVoice(): SpeechSynthesisVoice | undefined {
  if (typeof speechSynthesis === "undefined") return undefined;
  const voices = speechSynthesis.getVoices();
  const want = ["Daniel", "Google UK English Male", "Microsoft Ryan", "Arthur", "Oliver", "en-GB"];
  for (const w of want) { const v = voices.find((x) => x.name.includes(w) || (w === "en-GB" && x.lang === "en-GB")); if (v) return v; }
  return voices.find((v) => v.lang.startsWith("en")) ?? voices[0];
}

export function useVoice(opts: { onHeard: (text: string) => void | Promise<void> }) {
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [interim, setInterim] = useState("");
  const [serverTts, setServerTts] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<Rec | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const levelRaf = useRef(0);
  const onHeardRef = useRef(opts.onHeard);
  onHeardRef.current = opts.onHeard;

  useEffect(() => { fetch("/api/tts/status", { credentials: "include" }).then((r) => r.json()).then((j) => setServerTts(!!j.available)).catch(() => setServerTts(false)); }, []);

  const meter = useCallback((node: AudioNode, ctx: AudioContext) => {
    const an = ctx.createAnalyser(); an.fftSize = 512; node.connect(an);
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
        const res = await fetch("/api/tts", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
        if (res.ok) {
          const blob = await res.blob();
          const audio = new Audio(URL.createObjectURL(blob)); audioRef.current = audio;
          const ctx = ctxRef.current ?? (ctxRef.current = new AudioContext());
          const src = ctx.createMediaElementSource(audio); src.connect(ctx.destination);
          const stop = meter(src, ctx);
          await new Promise<void>((resolve) => { audio.onended = () => resolve(); audio.onerror = () => resolve(); audio.onpause = () => resolve(); void audio.play().catch(() => resolve()); });
          stop(); src.disconnect();
          return interrupted;
        }
      }
      if (typeof speechSynthesis === "undefined") { setError("This browser can't speak."); return false; }
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        const v = pickVoice(); if (v) u.voice = v;
        u.rate = 1.02; u.pitch = 0.9;
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
  }, [serverTts, stopSpeaking, meter, bargeIn]);

  const stopListening = useCallback(() => {
    recRef.current?.stop(); recRef.current = null;
    micStream.current?.getTracks().forEach((t) => t.stop()); micStream.current = null;
    cancelAnimationFrame(levelRaf.current); setLevel(0); setListening(false); setInterim("");
  }, []);

  /** Listen for one utterance; resolves with the text (empty if nothing was heard, or nothing within timeoutMs). */
  const listen = useCallback((opts: { timeoutMs?: number } = {}): Promise<string> => new Promise((resolve) => {
    const r = recognizer();
    if (!r) { setError("Voice input isn't available in this browser. Chrome or Safari work."); resolve(""); return; }
    stopSpeaking();
    recRef.current = r; r.lang = "en-US"; r.interimResults = true; r.continuous = false;
    let finalText = "", done = false, heardAnything = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); stopListening(); resolve(finalText.trim()); };
    // The reply window: if nobody has started talking by then, close the mic.
    const timer = opts.timeoutMs ? setTimeout(() => { if (!heardAnything) { try { r.abort(); } catch { /* fine */ } finish(); } }, opts.timeoutMs) : undefined;
    r.onresult = (e) => { heardAnything = true; let s = ""; for (let i = 0; i < e.results.length; i++) s += e.results[i]![0]!.transcript; setInterim(s); if (e.results[e.results.length - 1]?.isFinal) finalText = s; };
    r.onend = finish;
    r.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") setError(`Mic: ${e.error}`); finish(); };
    setListening(true); setError(undefined);
    navigator.mediaDevices?.getUserMedia({ audio: true }).then((stream) => {
      micStream.current = stream;
      const ctx = ctxRef.current ?? (ctxRef.current = new AudioContext());
      meter(ctx.createMediaStreamSource(stream), ctx);
    }).catch(() => undefined);
    try { r.start(); } catch { finish(); }
  }), [meter, stopSpeaking, stopListening]);

  const [conversation, setConversation] = useState(false);
  const convRef = useRef(false);
  const interruptedRef = useRef(false);
  const loop = useCallback(async () => {
    while (convRef.current) {
      const heard = await listen();
      if (!convRef.current) break;
      if (!heard) continue;
      if (/^(stop|that's all|goodbye|exit)\b/i.test(heard)) { convRef.current = false; setConversation(false); break; }
      await onHeardRef.current(heard);
      if (interruptedRef.current) { interruptedRef.current = false; }
    }
  }, [listen]);

  const startConversation = useCallback(() => { convRef.current = true; setConversation(true); void loop(); }, [loop]);
  const endConversation = useCallback(() => { convRef.current = false; setConversation(false); stopListening(); stopSpeaking(); }, [stopListening, stopSpeaking]);

  useEffect(() => () => { convRef.current = false; stopListening(); stopSpeaking(); }, [stopListening, stopSpeaking]);

  return { speak, stopSpeaking, listen, stopListening, speaking, listening, level, interim, serverTts, error, conversation, startConversation, endConversation };
}
