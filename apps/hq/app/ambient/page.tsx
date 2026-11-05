"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Core, type CoreState } from "@/components/Core";
import { Skyline } from "@/components/Skyline";
import { useLive } from "@/lib/live";
import { useVoice } from "@/lib/voice";
import { useClap, type ClapSensitivity } from "@/lib/clap";
import { api, post } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";

/**
 * Always-on mode for a screen on a stand: say "Jarvis" (or clap twice) to wake him, talk, he answers aloud.
 * The morning brief is read out when it runs; approvals are announced and can be decided by voice.
 */
type Phase = "off" | "sleeping" | "awake";
type SpeechRecognitionLike = { start(): void; stop(): void; abort(): void; lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
const IDLE_AFTER_MS = 25_000;
const REPLY_WINDOW_MS = 6_000;
const APPROVAL_VOICE_WINDOW_MS = 20_000;

export default function AmbientPage() {
  const { state, onEvent, pending, send: submit } = useLive();
  const [phase, setPhase] = useState<Phase>("off");
  const [cfg, setCfg] = useState<{ wakeWordKey: string | null; tz: string; voice: boolean } | null>(null);
  const [line, setLine] = useState("Tap Start, then say \"Jarvis\".");
  const [reply, setReply] = useState("");
  const [note, setNote] = useState<string>();
  const [now, setNow] = useState<Date | null>(null);
  const [wakeReady, setWakeReady] = useState<"none" | "wakeword" | "clap">("none");
  const busyRef = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const porcupine = useRef<{ release(): Promise<void>; terminate(): void } | null>(null);
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null);
  const pendingApproval = useRef<{ id: string; title: string; kind: string; askedAt: number } | null>(null);

  /** Ask Jarvis: returns the ack text at once plus a promise of the final answer. */
  const ask = useCallback(async (heard: string) => {
    setLine(heard); setReply("");
    const { ack, final } = await submit(heard, "voice");
    const first = await ack;
    return { ack: first, final: first?.kind === "final" ? Promise.resolve(first) : final };
  }, [submit]);

  const voice = useVoice({ onHeard: async () => undefined });
  const { speak, listen, stopSpeaking, stopListening } = voice;

  const chime = useCallback((up = true) => {
    try {
      const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(up ? 660 : 520, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(up ? 990 : 330, ctx.currentTime + 0.18);
      g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4); o.onended = () => void ctx.close();
    } catch { /* silent */ }
  }, []);

  /**
   * One wake. Rules: a six-second window for Phil to reply, at most one follow-up without saying "Jarvis"
   * again, stop words cut him off while he speaks, and a voice "approve" only counts within seconds of him
   * asking, never for money or trading strategies.
   */
  const converse = useCallback(async (opening?: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setPhase("awake");
    try {
      chime(true);
      await speak(opening ?? "Yes?", { bargeIn: true });
      let turns = 0;
      while (turns < 2) {
        const heard = await listen({ timeoutMs: REPLY_WINDOW_MS });
        if (!heard) break; // nothing in the window: back to sleep
        if (/^(stop|that's all|thanks jarvis|thank you jarvis|go to sleep|never mind|cancel)\b/i.test(heard)) { await speak("Standing by."); break; }
        const a = pendingApproval.current;
        if (a && Date.now() - a.askedAt < APPROVAL_VOICE_WINDOW_MS) {
          pendingApproval.current = null;
          if (/\b(approve|approved|yes|go ahead|do it)\b/i.test(heard)) {
            if (a.kind === "money" || a.kind === "strategy") { await speak("That one moves money, so it needs the screen or Telegram. It's waiting in Needs you."); continue; }
            await post(`/api/approvals/${a.id}/approve`, { note: "by voice" }); await speak(`Approved: ${a.title}.`); continue;
          }
          if (/\b(reject|rejected|no|don't|cancel)\b/i.test(heard)) { await post(`/api/approvals/${a.id}/reject`, { note: "by voice" }); await speak(`Rejected: ${a.title}.`); continue; }
          if (/\b(later|wait|hold)\b/i.test(heard)) { await speak("It's waiting in Needs you."); continue; }
        }
        pendingApproval.current = null;
        turns++;
        if (/\b(morning report|morning brief|daily brief|the brief)\b/i.test(heard)) {
          setLine(heard); setReply("");
          await speak("One moment.");
          const r = await post<{ message: ChatMessage }>("/api/brief");
          setReply(r.message.text); await speak(r.message.text, { bargeIn: true }); continue;
        }
        const { ack: first, final } = await ask(heard);
        if (!first) { await speak("Nothing came back. Try again.", { bargeIn: true }); continue; }
        setReply(first.text);
        await speak(first.text, { bargeIn: true });
        if (first.kind !== "final") {
          // He said "on it": wait for the real answer, up to a few minutes, and read it when it lands.
          const answer = await final;
          if (answer) { setReply(answer.text); await speak(answer.text, { bargeIn: true }); }
          else await speak("That's taking longer than usual. It'll be in Command when it lands.", { bargeIn: true });
        }
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      busyRef.current = false; setPhase("sleeping"); setLine("Say \"Jarvis\".");
      clearTimeout(idleTimer.current); idleTimer.current = setTimeout(() => setReply(""), IDLE_AFTER_MS);
    }
  }, [ask, chime, listen, speak]);

  // Without a Picovoice key: keep the browser's own speech recognition running and watch for the word "Jarvis".
  // It restarts itself when the browser ends a session and stays quiet while he's awake.
  const wordListener = useRef<{ stop(): void } | null>(null);
  const startWordListener = useCallback(() => {
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!C) return false;
    let stopped = false, rec: SpeechRecognitionLike | null = null;
    const spin = () => {
      if (stopped) return;
      if (busyRef.current) { setTimeout(spin, 800); return; }
      rec = new C(); rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
      rec.onresult = (e) => {
        if (busyRef.current) return;
        let s = ""; for (let i = e.resultIndex; i < e.results.length; i++) s += e.results[i]![0]!.transcript + " ";
        if (/\b(jarvis|hey jarvis|ok jarvis)\b/i.test(s)) { try { rec?.abort(); } catch { /* fine */ } void converse(); }
      };
      rec.onend = () => { if (!stopped) setTimeout(spin, 300); };
      rec.onerror = () => { /* onend follows and restarts */ };
      try { rec.start(); } catch { setTimeout(spin, 1500); }
    };
    spin();
    wordListener.current = { stop: () => { stopped = true; try { rec?.abort(); } catch { /* fine */ } } };
    return true;
  }, [converse]);

  // Wake word: Porcupine (on-device) when a key is configured; else the browser's speech recognition; else clap only.
  const startWake = useCallback(async () => {
    if (!cfg?.wakeWordKey) { setWakeReady(startWordListener() ? "wakeword" : "clap"); return; }
    try {
      const [{ PorcupineWorker, BuiltInKeyword }, { WebVoiceProcessor }] = await Promise.all([import("@picovoice/porcupine-web"), import("@picovoice/web-voice-processor")]);
      const w = await PorcupineWorker.create(cfg.wakeWordKey, [BuiltInKeyword.Jarvis], () => { if (!busyRef.current) void converse(); }, { publicPath: "/porcupine_params.pv" });
      await WebVoiceProcessor.subscribe(w);
      porcupine.current = { release: async () => { await WebVoiceProcessor.unsubscribe(w); await w.release(); }, terminate: () => w.terminate() };
      setWakeReady("wakeword");
    } catch (e) {
      setNote(`Wake word unavailable (${(e as Error).message.slice(0, 120)}); clapping still works.`);
      setWakeReady("clap");
    }
  }, [cfg, converse, startWordListener]);

  // Clap-to-wake: on by default; sensitivity and on/off are remembered on this device.
  const [clapOn, setClapOn] = useState(true);
  const [clapSens, setClapSens] = useState<ClapSensitivity>("normal");
  // Default: clap-wake only when there is no wake word; a saved choice on this device wins.
  useEffect(() => {
    if (!cfg) return;
    try {
      const saved = localStorage.getItem("hq.clap");
      setClapOn(saved ? saved !== "off" : false);
      const s = localStorage.getItem("hq.clapSens"); if (s === "low" || s === "normal" || s === "high") setClapSens(s);
    } catch { /* ignore */ }
  }, [cfg]);
  const setClap = (on: boolean) => { setClapOn(on); try { localStorage.setItem("hq.clap", on ? "on" : "off"); } catch { /* ignore */ } };
  const setSens = (s: ClapSensitivity) => { setClapSens(s); try { localStorage.setItem("hq.clapSens", s); } catch { /* ignore */ } };
  useClap(phase !== "off" && clapOn, () => { if (!busyRef.current) void converse(); }, { sensitivity: clapSens });

  const start = async () => {
    try { wakeLock.current = await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen") ?? null; } catch { /* some browsers refuse; the screen may dim */ }
    try { await document.documentElement.requestFullscreen?.(); } catch { /* fine */ }
    setPhase("sleeping"); setLine("Say \"Jarvis\".");
    await startWake();
    await speak("Jarvis online.");
  };
  const stop = async () => {
    stopListening(); stopSpeaking();
    wordListener.current?.stop(); wordListener.current = null;
    await porcupine.current?.release().catch(() => undefined); porcupine.current = null;
    await wakeLock.current?.release().catch(() => undefined); wakeLock.current = null;
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* fine */ }
    setPhase("off"); setWakeReady("none"); setLine("Tap Start, then say \"Jarvis\".");
  };

  useEffect(() => { api<{ wakeWordKey: string | null; tz: string; voice: boolean }>("/api/config").then(setCfg).catch(() => setCfg({ wakeWordKey: null, tz: "America/New_York", voice: false })); }, []);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const re = async () => { if (document.visibilityState === "visible" && phase !== "off" && !wakeLock.current) { try { wakeLock.current = await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen") ?? null; } catch { /* fine */ } } };
    document.addEventListener("visibilitychange", re); return () => document.removeEventListener("visibilitychange", re);
  }, [phase]);

  // The morning brief is read out when it runs; new approvals are announced and can be answered by voice.
  useEffect(() => onEvent((e) => {
    if (phase === "off") return;
    if (e.type === "brief") { void (async () => { if (busyRef.current) return; busyRef.current = true; setPhase("awake"); try { chime(true); setReply(e.text); await speak(`Morning, Phil. Here's the brief. ${e.text}`, { bargeIn: true }); } finally { busyRef.current = false; setPhase("sleeping"); } })(); }
    if (e.type === "approval.new") {
      const who = state?.agents.find((a) => a.id === e.approval.agentId)?.name ?? e.approval.agentId;
      pendingApproval.current = { id: e.approval.id, title: e.approval.title, kind: e.approval.kind, askedAt: Date.now() };
      void converse(`${who} needs your OK: ${e.approval.title}. Approve, reject, or later?`);
    }
  }), [onEvent, phase, state, speak, chime, converse]);

  useEffect(() => () => { wordListener.current?.stop(); void porcupine.current?.release().catch(() => undefined); void wakeLock.current?.release().catch(() => undefined); }, []);

  const coreState: CoreState = state?.status.killSwitch.all ? "paused" : voice.speaking ? "speaking" : voice.listening ? "listening" : phase === "awake" ? "thinking" : "idle";
  const label = phase === "off" ? "OFFLINE" : coreState === "speaking" ? "SPEAKING" : coreState === "listening" ? "LISTENING" : coreState === "thinking" ? "THINKING" : coreState === "paused" ? "PAUSED" : "STANDING BY";
  const tz = cfg?.tz ?? "America/New_York";

  return (
    <div className="grid-bg min-h-dvh flex flex-col items-center justify-between relative overflow-hidden select-none" style={{ padding: "max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))" }}>
      <Skyline dim />
      <div className="corner tl" /><div className="corner tr" /><div className="corner bl" /><div className="corner br" />
      <header className="relative w-full max-w-3xl flex items-start justify-between" style={{ zIndex: 1 }}>
        <div className="flex items-center gap-2">
          <span className="inline-block w-3.5 h-3.5 rounded-full border-2" style={{ borderColor: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
          <span className="display glow font-bold text-[15px] tracking-[0.22em]" style={{ color: "var(--ink-strong)" }}>J.A.R.V.I.S.</span>
          <span className="text-[10px] tracking-[0.16em] uppercase ml-2" style={{ color: "var(--muted)" }}>{phase === "off" ? "always-on mode" : wakeReady === "wakeword" ? (clapOn ? "say \"Jarvis\" or clap twice" : "say \"Jarvis\"") : clapOn ? "clap twice to wake" : "clap-wake is off"}{pending.length ? ` · ${pending.length} waiting` : ""}</span>
        </div>
        <div className="text-right">
          <div className="display glow font-semibold leading-none tracking-[0.06em] text-[28px] md:text-[40px]" style={{ color: "var(--ink-bright)" }}>{now ? now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : "--:--"}</div>
          <div className="text-[11px] tracking-[0.18em] uppercase" style={{ color: "var(--muted)" }}>{now ? now.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }) : ""}</div>
        </div>
      </header>

      <main className="relative flex flex-col items-center gap-5 w-full max-w-2xl" style={{ zIndex: 1 }}>
        <Core state={coreState} level={voice.level} size={Math.min(360, typeof window !== "undefined" ? window.innerWidth - 48 : 360)} label={label} />
        <p className="m-0 text-center text-[13px] tracking-[0.08em]" style={{ color: "var(--amber)", minHeight: 20 }}>{voice.interim || line}</p>
        {reply && <p className="m-0 text-center text-[15px] leading-relaxed max-h-48 overflow-y-auto px-2" style={{ color: "var(--ink-strong)" }}>{reply.slice(0, 900)}</p>}
        {note && <p className="m-0 text-center text-[11px]" style={{ color: "var(--red)" }}>{note}</p>}
        {voice.error && <p className="m-0 text-center text-[11px]" style={{ color: "var(--red)" }}>{voice.error}</p>}
      </main>

      <footer className="relative w-full max-w-3xl flex items-center justify-between gap-3" style={{ zIndex: 1 }}>
        <Link href="/" className="btn btn-sm">HQ</Link>
        <div className="flex flex-wrap items-center justify-center gap-2 text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--dim)" }}>
          <span>{cfg ? (cfg.voice ? "voice: ElevenLabs" : "voice: this device") : ""}{cfg ? (cfg.wakeWordKey ? " · wake word: on-device" : " · wake word: speech service") : ""}</span>
          <label className="btn btn-sm cursor-pointer" style={clapOn ? { borderColor: "var(--accent)" } : undefined}><input type="checkbox" className="sr-only" checked={clapOn} onChange={(e) => setClap(e.target.checked)} />clap {clapOn ? "on" : "off"}</label>
          {clapOn && <select className="input h-8 w-28 text-[10px] uppercase" aria-label="Clap sensitivity" value={clapSens} onChange={(e) => setSens(e.target.value as ClapSensitivity)}><option value="low">quiet room</option><option value="normal">normal</option><option value="high">big room</option></select>}
        </div>
        {phase === "off" ? <button className="btn btn-primary" onClick={start}>Start</button> : <button className="btn" onClick={stop}>Stop</button>}
      </footer>
    </div>
  );
}
