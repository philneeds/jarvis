"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice for Jarvis, built to feel like a conversation rather than a walkie-talkie.
 *
 * Listening: the mic Phil chose (remembered on this device) opens once per conversation and stays open. A small
 * voice-activity detector watches the level: speech starts when the room gets louder than its noise floor and an
 * utterance ends after a short silence. Each utterance is transcribed by the server (ElevenLabs) when it can, else
 * by the browser's own speech recognition.
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

const MIC_KEY = "hq.micId";
export function savedMic(): string | undefined { try { return localStorage.getItem(MIC_KEY) ?? undefined; } catch { return undefined; } }
export function saveMic(id: string | undefined) { try { if (id) localStorage.setItem(MIC_KEY, id); else localStorage.removeItem(MIC_KEY); } catch { /* ignore */ } }

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

// Voice-activity tuning (RMS of the time-domain signal, 0..1).
const VAD = { minFloor: 0.012, startRatio: 3, endSilenceMs: 700, minSpeechMs: 250, maxUtteranceMs: 25_000, preRollMs: 150 };

export function useVoice(opts: { onHeard: (text: string) => void | Promise<void> }) {
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [hearing, setHearing] = useState(false);      // speech detected right now
  const [transcribing, setTranscribing] = useState(false);
  const [level, setLevel] = useState(0);
  const [interim, setInterim] = useState("");
  const [serverTts, setServerTts] = useState<boolean | null>(null);
  const [serverStt, setServerStt] = useState(false);
  const [error, setError] = useState<string>();
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [micId, setMicIdState] = useState<string | undefined>();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<Rec | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const levelRaf = useRef(0);
  const abortListen = useRef<(() => void) | null>(null);
  const onHeardRef = useRef(opts.onHeard);
  onHeardRef.current = opts.onHeard;

  useEffect(() => {
    setMicIdState(savedMic());
    fetch("/api/tts/status", { credentials: "include" }).then((r) => r.json()).then((j) => { setServerTts(!!j.available); setServerStt(!!j.stt); }).catch(() => setServerTts(false));
  }, []);

  const ctx = () => ctxRef.current ?? (ctxRef.current = new AudioContext());

  /** Mics on this machine; labels appear once the mic has been allowed. */
  const refreshMics = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const list = all.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
      setMics(list);
      return list;
    } catch { return []; }
  }, []);
  const setMic = useCallback((id: string | undefined) => { saveMic(id); setMicIdState(id); }, []);

  /** Open the chosen mic once; later calls reuse it. */
  const openMic = useCallback(async (): Promise<MediaStream> => {
    if (micStream.current?.active) return micStream.current;
    const want = savedMic();
    const constraints = (id?: string): MediaStreamConstraints => ({ audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia(constraints(want)); }
    catch (e) {
      if (want) { stream = await navigator.mediaDevices.getUserMedia(constraints()); saveMic(undefined); setMicIdState(undefined); } // the saved mic is gone
      else throw e;
    }
    micStream.current = stream;
    void refreshMics();
    return stream;
  }, [refreshMics]);
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
    return res.ok ? res.blob() : null;
  }, []);

  const playBlob = useCallback(async (blob: Blob) => {
    const audio = new Audio(URL.createObjectURL(blob)); audioRef.current = audio;
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
        u.rate = 1.12; u.pitch = 0.9;
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

  /** Transcribe one recorded utterance on the server. */
  const transcribe = useCallback(async (blob: Blob): Promise<string> => {
    setTranscribing(true);
    try {
      const res = await fetch("/api/tts/stt", { method: "POST", credentials: "include", headers: { "content-type": blob.type || "audio/webm" }, body: blob });
      if (!res.ok) { setError("Couldn't transcribe that; using the browser instead."); setServerStt(false); return ""; }
      return ((await res.json()) as { text?: string }).text ?? "";
    } catch { return ""; } finally { setTranscribing(false); }
  }, []);

  /**
   * Listen for one utterance; resolves with the text ("" if nothing was heard, or nothing within timeoutMs).
   * The mic stays open between calls. Speech start/end come from the level, not from the recognizer.
   */
  const listen = useCallback(async (opts: { timeoutMs?: number } = {}): Promise<string> => {
    stopSpeaking();
    setError(undefined); setInterim("");
    let stream: MediaStream;
    try { stream = await openMic(); }
    catch { setError("Microphone not available. Allow the mic for this site, or pick another one under the mic menu."); return ""; }
    const c = ctx();
    if (c.state === "suspended") await c.resume().catch(() => undefined);
    const source = c.createMediaStreamSource(stream);
    const an = c.createAnalyser(); an.fftSize = 1024; source.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    setListening(true);

    const useServer = serverStt && typeof MediaRecorder !== "undefined";
    const mime = typeof MediaRecorder !== "undefined" ? (["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "") : "";
    let rec: Rec | null = null;
    let recText = "", recFinal = false;
    if (!useServer) {
      rec = recognizer();
      if (!rec) { setError("Voice input isn't available in this browser. Chrome or Safari work, or add an ElevenLabs key for server transcription."); setListening(false); source.disconnect(); return ""; }
      recRef.current = rec; rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
      rec.onresult = (e) => { let s = ""; for (let i = 0; i < e.results.length; i++) s += e.results[i]![0]!.transcript; recText = s; setInterim(s); if (e.results[e.results.length - 1]?.isFinal) recFinal = true; };
      rec.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") setError(`Mic: ${e.error}`); };
      rec.onend = () => { recFinal = true; };
      try { rec.start(); } catch { /* already running */ }
    }

    return new Promise<string>((resolve) => {
      let floor = 0.02, speaking = false, speechStart = 0, lastLoud = 0, done = false, chunks: Blob[] = [];
      let recorder: MediaRecorder | null = null;
      const t0 = performance.now();
      const finish = async (text: string) => {
        if (done) return; done = true;
        cancelAnimationFrame(raf); source.disconnect(); an.disconnect();
        if (rec) { try { rec.abort(); } catch { /* fine */ } recRef.current = null; }
        setListening(false); setHearing(false); setLevel(0); setInterim("");
        resolve(text.trim());
      };
      abortListen.current = () => { try { recorder?.state !== "inactive" && recorder?.stop(); } catch { /* fine */ } void finish(""); };
      const endUtterance = async () => {
        setHearing(false);
        if (useServer) {
          const blob = await new Promise<Blob>((res) => { if (!recorder || recorder.state === "inactive") return res(new Blob(chunks, { type: mime })); recorder.onstop = () => res(new Blob(chunks, { type: mime })); recorder.stop(); });
          cancelAnimationFrame(raf); source.disconnect(); an.disconnect(); setListening(false); setLevel(0);
          const text = await transcribe(blob);
          done = true; resolve(text.trim());
        } else {
          // Give the recognizer a moment to finalize, then take what it has.
          try { rec?.stop(); } catch { /* fine */ }
          const until = performance.now() + 1200;
          while (!recFinal && performance.now() < until) await new Promise((r) => setTimeout(r, 50));
          void finish(recText);
        }
      };
      let raf = 0;
      const tick = () => {
        if (done) return;
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
        const rms = Math.sqrt(sum / buf.length);
        setLevel(Math.min(1, rms * 4));
        const now = performance.now();
        if (!speaking) floor = Math.max(VAD.minFloor, floor * 0.98 + rms * 0.02); // the room's noise, slowly tracked
        const loud = rms > floor * VAD.startRatio;
        if (loud) lastLoud = now;
        if (!speaking && loud) {
          speaking = true; speechStart = now; setHearing(true);
          if (useServer && mime) { chunks = []; recorder = new MediaRecorder(stream, { mimeType: mime }); recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); }; recorder.start(250); }
        } else if (speaking && now - lastLoud > VAD.endSilenceMs) {
          if (now - speechStart - VAD.endSilenceMs < VAD.minSpeechMs) { speaking = false; try { recorder?.stop(); } catch { /* fine */ } chunks = []; setHearing(false); } // a cough, not words
          else { void endUtterance(); return; }
        } else if (speaking && now - speechStart > VAD.maxUtteranceMs) { void endUtterance(); return; }
        if (!speaking && opts.timeoutMs && now - t0 > opts.timeoutMs) { void finish(""); return; }
        raf = requestAnimationFrame(tick);
      };
      tick();
    });
  }, [openMic, serverStt, stopSpeaking, transcribe]);

  const [conversation, setConversation] = useState(false);
  const convRef = useRef(false);
  const loop = useCallback(async () => {
    while (convRef.current) {
      const heard = await listen();
      if (!convRef.current) break;
      if (!heard) continue;
      if (/^(stop|that's all|that is all|goodbye|exit|thanks,? that's all)\b/i.test(heard)) { convRef.current = false; setConversation(false); chime(ctx(), false); closeMic(); break; }
      await onHeardRef.current(heard);
    }
  }, [listen, closeMic]);

  /** Start a conversation: open the mic, chime, listen. No spoken "Listening." to wait through. */
  const startConversation = useCallback(async () => {
    convRef.current = true; setConversation(true); setError(undefined);
    try { await openMic(); chime(ctx(), true); } catch { setError("Microphone not available. Allow the mic for this site, or pick another one under the mic menu."); convRef.current = false; setConversation(false); return; }
    void loop();
  }, [loop, openMic]);
  const endConversation = useCallback(() => { convRef.current = false; setConversation(false); stopListening(); stopSpeaking(); closeMic(); }, [stopListening, stopSpeaking, closeMic]);

  useEffect(() => () => { convRef.current = false; stopListening(); stopSpeaking(); closeMic(); }, [stopListening, stopSpeaking, closeMic]);

  return { speak, stopSpeaking, listen, stopListening, speaking, listening, hearing, transcribing, level, interim, serverTts, serverStt, error, conversation, startConversation, endConversation, mics, micId, setMic, refreshMics };
}
