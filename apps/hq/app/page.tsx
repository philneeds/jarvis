"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "@/components/Shell";
import { Clock } from "@/components/Clock";
import { Towers } from "@/components/Towers";
import { Objective } from "@/components/Objective";
import { Skyline } from "@/components/Skyline";
import { Core, type CoreState } from "@/components/Core";
import { Transcript } from "@/components/Transcript";
import { useLive } from "@/lib/live";
import { useVoice } from "@/lib/voice";
import { api, timeAgo } from "@/lib/api";
import { meaningful } from "@/lib/activity";

const FILLERS = ["One moment.", "Let me look.", "On it.", "Checking."];

/** True from the lg breakpoint up, where the home screen runs three columns. */
function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

export default function HomePage() {
  const { state, pending, attention, activity, messages, send: submit } = useLive();
  const [on, setOn] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const wide = useWide();
  const [heardText, setHeardText] = useState<string>();
  const voice = useVoice({
    onHeard: async (heard) => {
      setBusy(true); setHeardText(heard);
      try {
        const { ack, final } = await submit(heard, "voice");
        setHeardText(undefined);
        // If the real acknowledgement takes more than a beat, say something small so the room isn't silent.
        const first = await Promise.race([ack, new Promise<null>((r) => setTimeout(() => r(null), 1400))]);
        let spoken = first;
        if (!first) { await voice.speak(FILLERS[Math.floor(Math.random() * FILLERS.length)]!); spoken = await ack; }
        if (spoken) await voice.speak(spoken.text, { bargeIn: true });
        if (spoken?.kind !== "final") { const answer = await final; if (answer) await voice.speak(answer.text, { bargeIn: true }); }
      } finally { setBusy(false); setHeardText(undefined); }
    },
  });
  const [money, setMoney] = useState<{ key: string; value: string }[]>([]);
  const [visual, setVisual] = useState<{ key: string; value: string } | null>(null);
  const [since, setSince] = useState<string>();

  useEffect(() => {
    try { setOn(localStorage.getItem("hq.display") !== "off"); setSince(localStorage.getItem("hq.lastSeen") ?? undefined); } catch { /* ignore */ }
    const mark = () => { try { localStorage.setItem("hq.lastSeen", new Date().toISOString()); } catch { /* ignore */ } };
    window.addEventListener("pagehide", mark);
    api<{ metrics: { key: string; label: string; unit?: string; latest?: number }[] }>("/api/ventures/money").then((r) => setMoney(r.metrics.filter((m) => m.latest !== undefined).slice(0, 3).map((m) => ({ key: m.label, value: m.unit === "$" ? `$${m.latest!.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : String(m.latest) })))).catch(() => undefined);
    api<{ items: { key: string; value: string }[] }>("/api/memory?scope=agent:joi").then((r) => setVisual(r.items.find((i) => i.key.startsWith("visual")) ?? null)).catch(() => undefined);
    return () => window.removeEventListener("pagehide", mark);
  }, []);
  const toggle = () => { setOn(!on); try { localStorage.setItem("hq.display", on ? "off" : "on"); } catch { /* ignore */ } };

  const lastJarvis = [...messages].reverse().find((m) => m.role === "jarvis" && m.kind !== "ack");
  const errors = state?.agents.filter((a) => a.status === "error") ?? [];
  const openItems = attention.filter((i) => i.status === "open");
  const needs = [
    ...openItems.slice(0, 4).map((i) => ({ tag: (state?.agents.find((a) => a.id === i.agentId)?.name ?? i.agentId).toUpperCase(), color: "var(--amber)", text: i.title, href: "/attention" })),
    ...pending.slice(0, 3).map((p) => ({ tag: state?.ventures[state.agents.find((a) => a.id === p.agentId)?.venture ?? "root"]?.short ?? p.agentId.toUpperCase(), color: state?.ventures[state.agents.find((a) => a.id === p.agentId)?.venture ?? "root"]?.color, text: p.title, href: "/approvals" })),
    ...errors.slice(0, 2).map((a) => ({ tag: a.name.toUpperCase(), color: "var(--red)", text: a.lastError?.slice(0, 80) ?? "error", href: `/web?agent=${a.id}` })),
  ];
  const sinceAt = since ? new Date(since).getTime() : 0;
  // Only what's worth reading counts: hand-offs, approvals, errors, memory, schedules that did something. Not every model run.
  const fresh = activity.filter((e) => meaningful(e) && new Date(e.at).getTime() > sinceAt);
  const changes = fresh.slice(0, 5);
  const quiet = fresh.length;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const line = text.trim(); if (!line || busy) return;
    setText(""); setBusy(true);
    try {
      const { ack, final } = await submit(line);
      const first = await ack;
      setBusy(false);
      if (voiceOn && first) void voice.speak(first.text);
      if (voiceOn && first?.kind !== "final") { const answer = await final; if (answer) void voice.speak(answer.text); }
    } finally { setBusy(false); }
  };

  const toggleVoice = () => {
    if (voice.conversation) { voice.endConversation(); setVoiceOn(false); return; }
    setVoiceOn(true);
    void voice.startConversation();
  };
  const coreState: CoreState = state?.status.killSwitch.all ? "paused" : voice.speaking ? "speaking" : voice.hearing ? "listening" : busy || state?.agents.some((a) => a.status === "working") ? "thinking" : voice.listening ? "listening" : "idle";
  const coreLabel = coreState === "paused" ? "PAUSED" : coreState === "speaking" ? "SPEAKING" : voice.hearing ? "HEARING YOU" : coreState === "thinking" ? "THINKING" : voice.listening ? "LISTENING" : voice.conversation ? "READY" : "STANDING BY";

  const orb = <Core state={coreState} level={voice.level} label={coreLabel} />;
  const core = (
    <div className="flex flex-col items-center gap-4 w-full max-w-2xl">
      {!wide && orb}
      {voice.error && <p className="m-0 text-center text-[11px]" style={{ color: "var(--red)" }}>{voice.error}</p>}
      <form onSubmit={send} className="flex gap-1.5 w-full">
        <label htmlFor="home-cmd" className="sr-only">Command Jarvis</label>
        <div className="input flex items-center gap-2 flex-1"><span style={{ color: "var(--accent)" }}>&gt;_</span><input id="home-cmd" className="flex-1 min-w-0 bg-transparent border-0 outline-none h-full" placeholder="Talk to Jarvis, @ an agent, / for commands" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="send" /></div>
        <button type="button" className={`btn w-11 px-0 flex-none ${voice.conversation ? "btn-primary" : ""}`} onClick={toggleVoice} aria-pressed={voice.conversation} aria-label={voice.conversation ? "End voice conversation" : "Start voice conversation"} title={voice.conversation ? "End conversation" : "Talk with Jarvis"}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
        </button>
        <button type="button" className="btn w-11 px-0 flex-none" onClick={() => { if (voice.speaking) voice.stopSpeaking(); else if (lastJarvis) void voice.speak(lastJarvis.text); }} aria-label={voice.speaking ? "Stop speaking" : "Read the last reply aloud"} title={voice.speaking ? "Stop" : "Hear it"}>
          {voice.speaking ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" /></svg> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>}
        </button>
        <button className="btn btn-primary w-11 px-0 flex-none" disabled={busy || !text.trim()} aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></button>
      </form>
      <div className="relative flex items-center gap-3 text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--dim)" }}>
        {voice.hearing ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={voice.finishTurn} aria-label="Send what I said now">Send now</button>
        ) : (
          <span>{voice.conversation ? "listening · pause to send · say \"stop\" to end" : voice.serverTts ? "voice: ElevenLabs" : "voice: this device"}</span>
        )}
      </div>
      <Transcript pendingText={heardText ?? (voice.interim || undefined)} />
    </div>
  );

  return (
    <Shell>
      <Skyline dim={on} />
      <div className="relative flex-1 flex flex-col p-4 md:p-6 gap-5" style={{ zIndex: 1 }}>
        {on ? (
          <>
            <div className="corner tl" /><div className="corner tr" /><div className="corner bl" /><div className="corner br" />
            <div className="flex items-start justify-between gap-4 lg:grid lg:grid-cols-[300px_1fr_300px] lg:gap-6">
              <div className="flex flex-col gap-2 flex-1 md:flex-none md:w-72 lg:w-auto">
                <div className="flex items-baseline gap-3 text-[11px] tracking-[0.14em] whitespace-nowrap">
                  <span className="display font-bold text-lg tracking-[0.08em]" style={{ color: "var(--ink-strong)" }}>LV {Math.max(1, Math.floor((activity.length + messages.length) / 50) + (state?.status.phase ?? 0))}</span>
                  <span style={{ color: "var(--muted)" }}>Phase {state?.status.phase ?? 0}</span>
                  <span className="ml-auto" style={{ color: "var(--amber)" }}>{state?.pendingApprovals ?? 0} waiting</span>
                </div>
                <div className="bar"><i style={{ width: `${Math.min(100, ((activity.length + messages.length) % 50) * 2)}%` }} /></div>
                <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{state?.status.text ?? "connecting"}</span>
              </div>
              {wide && <div className="flex justify-center">{orb}</div>}
              <Clock since={since} />
            </div>

            <div className="grid gap-6 lg:grid-cols-[300px_1fr_300px] lg:items-start">
              <div className="flex flex-col gap-7 order-2 lg:order-1">
                <section aria-label="Needs your attention" className="flex flex-col gap-2">
                  <span className="label label-amber">❬ Needs your attention · {openItems.length + pending.length + errors.length}</span>
                  {needs.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing needs you. Agents&apos; asks, approvals and errors land here.</span>}
                  {needs.map((n, i) => <Link key={i} href={n.href} className="flex gap-2 text-[12px] leading-snug" style={{ color: "var(--ink-bright)" }}><span className="w-20 flex-none text-[11px]" style={{ color: n.color }}>{n.tag}</span><span>{n.text}</span></Link>)}
                  <Link href="/attention" className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--amber)" }}>Open all ›</Link>
                </section>
                <section aria-label="Money pulse" className="flex flex-col gap-2">
                  <span className="label" style={{ color: "var(--gold)" }}>❬ Money pulse · Munger</span>
                  {money.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>No numbers yet. Add net worth and cash on the <Link href="/ventures/money" style={{ color: "var(--gold)" }}>Money page</Link>, or Munger will in Phase 2.</span>}
                  {money.map((m) => <Link key={m.key} href="/ventures/money" className="flex justify-between text-[12px]"><span style={{ color: "var(--muted)" }}>{m.key.toUpperCase()}</span><span style={{ color: "var(--ink-bright)" }}>{m.value}</span></Link>)}
                  <span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Mayne · {state?.status.killSwitch.trading ? "trading paused" : "all limits ok"}</span>
                </section>
                <section aria-label="Visuals from Joi" className="flex flex-col gap-2">
                  <span className="label">❬ Visuals · Joi</span>
                  <div className="panel h-40 flex items-center justify-center text-[11px] tracking-[0.14em] uppercase text-center px-4" style={{ color: "var(--ink-strong)", backgroundImage: "repeating-linear-gradient(135deg, rgba(124,196,255,0.08) 0 1px, transparent 1px 10px)" }}>
                    {visual ? <img src={visual.value} alt={visual.key} className="max-h-full max-w-full object-contain" /> : "Joi's first visual lands in Phase 2"}
                  </div>
                </section>
              </div>

              <div className="flex flex-col items-center order-1 lg:order-2">{core}</div>

              <div className="flex flex-col gap-7 order-3 lg:items-end lg:text-right">
                <Towers />
                <section aria-label="Since you left" className="flex flex-col gap-2 w-full lg:items-end">
                  <span className="label">Since you left · {quiet ? `${quiet} ${quiet === 1 ? "thing" : "things"}` : "quiet"} ❭</span>
                  {changes.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing moved. Hand-offs, approvals and errors show here as agents work.</span>}
                  {changes.map((c) => <div key={c.id} className="flex gap-2 text-[12px] leading-snug lg:flex-row-reverse"><span className="w-20 flex-none text-[11px] lg:text-right" style={{ color: state?.ventures[state.agents.find((a) => a.id === c.agentId)?.venture ?? "root"]?.color }}>{(state?.agents.find((a) => a.id === c.agentId)?.name ?? c.agentId).toUpperCase()}</span><span style={{ color: "var(--ink-bright)" }}>{c.summary.slice(0, 90)}</span><span className="hidden lg:inline" style={{ color: "var(--dim)" }}>{timeAgo(c.at)}</span></div>)}
                  <Link href="/activity" className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--accent)" }}>{quiet > changes.length ? `${quiet - changes.length} more · ` : ""}Full log ›</Link>
                </section>
                <div className="w-full text-left"><Objective /></div>
              </div>
            </div>

            <div className="flex items-end justify-between gap-4 mt-auto">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full border-2 flex items-center justify-center" style={{ borderColor: "var(--accent)", boxShadow: "0 0 12px rgba(124,196,255,0.6)" }}><span className="display font-bold text-lg" style={{ color: "var(--ink-strong)" }}>P</span></div>
                <div className="flex flex-col gap-0.5 text-[11px] tracking-[0.12em]"><span style={{ color: "var(--ink-strong)" }}>PHIL</span><span style={{ color: "var(--muted)" }}>RECOVERY — · DOC (PHASE 3)</span></div>
              </div>
              <div className="flex"><button className="btn btn-sm" onClick={toggle}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" /></svg>Display off</button></div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-end pb-24 gap-4">
            <span className="text-[10px] tracking-[0.16em] uppercase" style={{ color: "var(--dim)" }}>Joi's skyline · display off</span>
            <button className="btn btn-sm" onClick={toggle}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" /></svg>Display on</button>
          </div>
        )}
      </div>
    </Shell>
  );
}
