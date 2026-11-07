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
import { Working } from "@/components/Working";
import { useLive } from "@/lib/live";
import { useVoice } from "@/lib/voice";
import { useClap, type ClapSensitivity } from "@/lib/clap";
import { api, post, timeAgo } from "@/lib/api";
import { clip, meaningful, readable } from "@/lib/activity";

const FILLERS = ["One moment.", "Let me look.", "On it.", "Checking."];

/** True while the viewport is at least `px` wide. */
function useMinWidth(px: number) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const on = () => setWide(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return wide;
}

/** The top band and the columns below share these tracks so everything lines up: 240px sides at lg, 300px at xl. */
const COLS = "lg:grid-cols-[240px_minmax(0,1fr)_240px] xl:grid-cols-[300px_minmax(0,1fr)_300px]";

export default function HomePage() {
  const { state, pending, attention, activity, messages, send: submit } = useLive();
  const [on, setOn] = useState(true);
  // Minimal: the clock, the orb and the conversation, nothing else. Remembered per device, like Display off.
  const [minimal, setMinimal] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const roomy = useMinWidth(640);   // room for the full input hint
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
  // Clap-to-wake on the home screen too: a double clap starts a voice conversation, same switch and sensitivity as Always on.
  const [clapOn, setClapOn] = useState(false);
  const [clapSens, setClapSens] = useState<ClapSensitivity>("normal");
  useEffect(() => { try { setClapOn(localStorage.getItem("hq.clap") === "on"); const s = localStorage.getItem("hq.clapSens"); if (s === "low" || s === "normal" || s === "high") setClapSens(s); } catch { /* ignore */ } }, []);
  const setClap = (v: boolean) => { setClapOn(v); try { localStorage.setItem("hq.clap", v ? "on" : "off"); } catch { /* ignore */ } };
  const setSens = (s: ClapSensitivity) => { setClapSens(s); try { localStorage.setItem("hq.clapSens", s); } catch { /* ignore */ } };
  const [money, setMoney] = useState<{ key: string; value: string }[]>([]);
  const [visual, setVisual] = useState<{ key: string; value: string } | null>(null);
  const [since, setSince] = useState<string>();
  const [background, setBackground] = useState<string | null>(null);

  useEffect(() => {
    try { setOn(localStorage.getItem("hq.display") !== "off"); setMinimal(localStorage.getItem("hq.layout") === "minimal"); setSince(localStorage.getItem("hq.lastSeen") ?? undefined); } catch { /* ignore */ }
    const mark = () => { try { localStorage.setItem("hq.lastSeen", new Date().toISOString()); } catch { /* ignore */ } };
    window.addEventListener("pagehide", mark);
    api<{ metrics: { key: string; label: string; unit?: string; latest?: number }[] }>("/api/ventures/money").then((r) => setMoney(r.metrics.filter((m) => m.latest !== undefined).slice(0, 3).map((m) => ({ key: m.label, value: m.unit === "$" ? `$${m.latest!.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : String(m.latest) })))).catch(() => undefined);
    api<{ items: { key: string; value: string }[] }>("/api/memory?scope=agent:joi").then((r) => setVisual(r.items.find((i) => i.key.startsWith("visual")) ?? null)).catch(() => undefined);
    api<{ background: string | null }>("/api/display").then((r) => setBackground(r.background)).catch(() => undefined);
    return () => window.removeEventListener("pagehide", mark);
  }, []);
  const toggle = () => { setOn(!on); try { localStorage.setItem("hq.display", on ? "off" : "on"); } catch { /* ignore */ } };
  const toggleMinimal = () => { setMinimal(!minimal); try { localStorage.setItem("hq.layout", minimal ? "full" : "minimal"); } catch { /* ignore */ } };

  const lastJarvis = [...messages].reverse().find((m) => m.role === "jarvis" && m.kind !== "ack");
  const errors = state?.agents.filter((a) => a.status === "error") ?? [];
  const openItems = attention.filter((i) => i.status === "open");
  const agentOf = (id: string) => state?.agents.find((a) => a.id === id);
  // Venture tag for a line: RANGE, HQ, PROEDGE… in the venture's colour.
  const tagOf = (venture?: string) => {
    const v = state?.ventures[(venture ?? "root") as keyof NonNullable<typeof state>["ventures"]];
    const word = !venture || venture === "root" || venture === "command" ? "HQ" : (v?.short ?? venture.toUpperCase()).split(/[.\s]/)[0]!;
    return { word, color: v?.color ?? "var(--accent)" };
  };
  const waiting = openItems.length + pending.length;
  // A preview, not a second inbox: approvals first (they block an agent), then the oldest to-dos. Three lines.
  const preview = [
    ...pending.map((p) => ({ id: p.id, kind: "approve" as const, text: p.title, ...tagOf(agentOf(p.agentId)?.venture) })),
    ...[...openItems].sort((a, b) => (a.at < b.at ? -1 : 1)).map((i) => ({ id: i.id, kind: "todo" as const, text: i.title, ...tagOf(i.venture ?? agentOf(i.agentId)?.venture) })),
  ].slice(0, 3);
  const [ticking, setTicking] = useState<string | null>(null);
  const tick = async (id: string) => { setTicking(id); try { await post(`/api/attention/${id}/done`); } finally { setTicking(null); } };
  const sinceAt = since ? new Date(since).getTime() : 0;
  // Only what's worth reading counts: hand-offs, approvals, errors, memory, schedules that did something. Not every
  // model run, and not what's already sitting in Needs you.
  const waitingTitles = [...openItems.map((i) => i.title), ...pending.map((p) => p.title)];
  const fresh = activity.filter((e) => meaningful(e) && new Date(e.at).getTime() > sinceAt && !(e.kind === "approval" && waitingTitles.some((t) => e.summary.includes(t))));
  const changes = fresh.slice(0, 5);
  const quiet = fresh.length;
  const xp = activity.length + messages.length;
  const level = Math.max(1, Math.floor(xp / 50) + (state?.status.phase ?? 0));

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
  useClap(on && clapOn && !voice.conversation, () => { if (!busy && !voice.conversation) { setVoiceOn(true); void voice.startConversation(); } }, { sensitivity: clapSens });
  const coreState: CoreState = state?.status.killSwitch.all ? "paused" : voice.speaking ? "speaking" : voice.hearing ? "listening" : busy || state?.agents.some((a) => a.status === "working") ? "thinking" : voice.listening ? "listening" : "idle";
  const coreLabel = coreState === "paused" ? "PAUSED" : coreState === "speaking" ? "SPEAKING" : voice.hearing ? "HEARING YOU" : coreState === "thinking" ? "THINKING" : voice.listening ? "LISTENING" : voice.conversation ? "READY" : "STANDING BY";

  const orb = <Core state={coreState} level={voice.level} label={coreLabel} />;
  const core = (
    <div className="flex flex-col items-center gap-4 w-full max-w-2xl">
      {orb}
      {voice.error && <p className="m-0 text-center text-[11px]" style={{ color: "var(--red)" }}>{voice.error}</p>}
      <form onSubmit={send} className="flex gap-1.5 w-full">
        <label htmlFor="home-cmd" className="sr-only">Command Jarvis</label>
        <div className="input flex items-center gap-2 flex-1"><span className="hidden sm:inline" style={{ color: "var(--accent)" }} aria-hidden="true">&gt;_</span><input id="home-cmd" className="flex-1 min-w-0 bg-transparent border-0 outline-none h-full" placeholder={roomy ? "Talk to Jarvis or @ an agent" : "Ask Jarvis or @ agent"} value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="send" /></div>
        <button type="button" className={`btn w-11 px-0 flex-none ${voice.conversation ? "btn-primary" : ""}`} onClick={toggleVoice} aria-pressed={voice.conversation} aria-label={voice.conversation ? "End voice conversation" : "Start voice conversation"} title={voice.conversation ? "End conversation" : "Talk with Jarvis"}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
        </button>
        <button type="button" className="btn w-11 px-0 flex-none" onClick={() => { if (voice.speaking) voice.stopSpeaking(); else if (lastJarvis) void voice.speak(lastJarvis.text); }} aria-label={voice.speaking ? "Stop speaking" : "Read the last reply aloud"} title={voice.speaking ? "Stop" : "Hear it"}>
          {voice.speaking ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" /></svg> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>}
        </button>
        <button className="btn btn-primary w-11 px-0 flex-none" disabled={busy || !text.trim()} aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></button>
      </form>
      <div className="relative flex items-center gap-3 text-[11px] tracking-[0.14em] uppercase text-center" style={{ color: "var(--muted)" }}>
        {voice.hearing ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={voice.finishTurn} aria-label="Send what I said now">Send now</button>
        ) : (
          <span>{voice.conversation ? "listening · pause to send · say \"stop\" to end" : `${voice.serverTts ? "voice: ElevenLabs" : "voice: this device"}${clapOn ? " · clap twice to talk" : ""}`}</span>
        )}
        {!voice.conversation && (
          <label className="btn btn-sm cursor-pointer normal-case tracking-normal" style={clapOn ? { borderColor: "var(--accent)" } : undefined} title="A double clap starts a voice conversation (uses the mic while on)"><input type="checkbox" className="sr-only" checked={clapOn} onChange={(e) => setClap(e.target.checked)} />clap {clapOn ? "on" : "off"}</label>
        )}
        {!voice.conversation && clapOn && <select className="input h-8 w-28 text-[10px] uppercase" aria-label="Clap sensitivity" value={clapSens} onChange={(e) => setSens(e.target.value as ClapSensitivity)}><option value="low">quiet room</option><option value="normal">normal</option><option value="high">big room</option></select>}
      </div>
      <Working />
      <Transcript pendingText={heardText ?? (voice.interim || undefined)} />
      {/* What changed while Phil was away, right under the input. Hidden when nothing did. */}
      {changes.length > 0 && (
        <section aria-label="Since you left" className="w-full flex flex-col gap-2 mt-2 text-left">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="label m-0 font-normal">Since you left · {quiet} {quiet === 1 ? "thing" : "things"}</h2>
            <Link href="/activity" className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--accent)" }}>{quiet > changes.length ? `${quiet - changes.length} more · ` : ""}Full log ›</Link>
          </div>
          <ul className="m-0 p-0 list-none flex flex-col gap-2 border-t pt-2" style={{ borderColor: "var(--line)" }}>
            {changes.map((c) => {
              const who = agentOf(c.agentId);
              const line = readable(c, state);
              // Phil's own edits are logged under Jarvis; tag them as his. Long names go by surname.
              const mine = line.startsWith("Phil ");
              const name = mine ? "Phil" : who?.name ?? c.agentId;
              return (
                <li key={c.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] gap-x-3 items-baseline text-[12px] leading-snug">
                  <span className="truncate text-[11px] tracking-[0.08em]" title={name} style={{ color: mine ? "var(--accent)" : state?.ventures[who?.venture ?? "root"]?.color }}>{(name.length > 10 ? name.split(" ").pop()! : name).toUpperCase()}</span>
                  <span style={{ color: "var(--ink-bright)" }}>{clip(line)}</span>
                  <time dateTime={c.at} className="text-[11px] whitespace-nowrap" style={{ color: "var(--muted)" }}>{timeAgo(c.at)}</time>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );

  const power = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" /></svg>;

  return (
    <Shell>
      {on || !background ? <Skyline dim={on} /> : (
        // Display off: Phil's own picture, full screen.
        <div aria-hidden="true" className="fixed inset-0" style={{ zIndex: 0, backgroundImage: `url(/api/uploads/${background})`, backgroundSize: "cover", backgroundPosition: "center" }} />
      )}
      <div className="relative flex-1 flex flex-col p-4 md:p-6 gap-5" style={{ zIndex: 1 }}>
        {on ? (
          <>
            {/* One short header row: level on the left, the clock on the right. The columns all start under it. */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1.5 w-56 xl:w-72" title={`${xp % 50} of 50 to the next level`}>
                <div className="flex items-baseline gap-3 text-[11px] tracking-[0.14em]">
                  <span className="display font-bold text-lg tracking-[0.08em]" style={{ color: "var(--ink-strong)" }}>LV {level}</span>
                  <span style={{ color: "var(--muted)" }}>PHASE {state?.status.phase ?? 0}</span>
                </div>
                <div className="bar"><i style={{ width: `${Math.min(100, (xp % 50) * 2)}%` }} /></div>
              </div>
              <Clock since={since} />
            </div>

            {minimal ? (
              <div className="flex-1 flex flex-col items-center justify-center py-6">{core}</div>
            ) : (
            <div className={`grid gap-6 ${COLS} lg:items-start`}>
              <div data-col="left" className="flex flex-col gap-5 order-2 lg:order-1 min-w-0">
                <section aria-label="Needs your attention" className="flex flex-col gap-2">
                  <Link href="/attention" className={`label ${waiting ? "label-amber" : ""}`}>❬ Needs your attention · {waiting}</Link>
                  {waiting === 0 ? <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing waiting.</span> : (
                    <>
                      <div className="flex gap-3 text-[11px] tracking-[0.12em] uppercase">
                        {pending.length > 0 && <Link href="/attention#approve" style={{ color: "var(--amber)" }}>Approve {pending.length}</Link>}
                        {pending.length > 0 && <span style={{ color: "var(--dim)" }}>·</span>}
                        <Link href="/attention#todo" style={{ color: openItems.length ? "var(--amber)" : "var(--muted)" }}>To do {openItems.length}</Link>
                      </div>
                      <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                        {preview.map((n) => (
                          <li key={n.id} className="flex items-center gap-2 text-[12px] leading-snug min-w-0">
                            <span className="w-16 flex-none text-[10px] tracking-[0.1em] truncate" style={{ color: n.color }}>{n.word}</span>
                            <Link href={`/attention#${n.kind}`} className="flex-1 min-w-0 truncate" style={{ color: "var(--ink-bright)" }} title={n.text}>{n.text}</Link>
                            {n.kind === "todo"
                              ? <button className="btn btn-sm h-7 w-7 px-0 flex-none" disabled={ticking === n.id} onClick={() => void tick(n.id)} aria-label={`Done: ${n.text}`} title="Done">✓</button>
                              : <Link href="/attention#approve" className="btn btn-sm h-7 px-2 flex-none" aria-label={`Review ${n.text}`}>Review</Link>}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {errors.length > 0 && <Link href={`/web?agent=${errors[0]!.id}`} className="text-[12px]" style={{ color: "var(--red)" }}>{errors.length === 1 ? `${errors[0]!.name} hit an error ›` : `${errors.length} agents hit errors ›`}</Link>}
                </section>
                <section aria-label="Money pulse" className="flex flex-col gap-2">
                  <span className="label">❬ Money pulse · Munger</span>
                  {money.length === 0
                    ? <Link href="/ventures/money" className="text-[12px]" style={{ color: "var(--accent)" }}>Add net worth →</Link>
                    : money.map((m) => <Link key={m.key} href="/ventures/money" className="flex justify-between gap-3 text-[12px]"><span style={{ color: "var(--muted)" }}>{m.key.toUpperCase()}</span><span style={{ color: "var(--ink-bright)" }}>{m.value}</span></Link>)}
                  {state?.status.killSwitch.trading && <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--amber)" }}>Mayne · trading paused</span>}
                </section>
                <section aria-label="Visuals from Joi" className="flex flex-col gap-2">
                  <Link href="/agents/joi" className="label">❬ Visuals · Joi</Link>
                  <div className="panel h-36 flex items-center justify-center px-4 text-[11px] tracking-[0.14em] uppercase text-center" style={{ color: "var(--muted)", backgroundImage: visual ? undefined : "repeating-linear-gradient(135deg, rgba(124,196,255,0.08) 0 1px, transparent 1px 10px)" }}>
                    {visual ? <img src={visual.value} alt={visual.key} className="max-h-full max-w-full object-contain" /> : "Joi's latest visual shows here"}
                  </div>
                </section>
              </div>

              <div data-col="centre" className="flex flex-col items-center order-1 lg:order-2 min-w-0">{core}</div>

              <div data-col="right" className="flex flex-col gap-5 order-3 min-w-0">
                <Towers />
              </div>
            </div>
            )}

            <div className={`grid gap-4 ${COLS} items-end mt-auto`}>
              <div className="flex items-center gap-3 order-2 lg:order-1">
                {!minimal && <>
                  <div className="w-11 h-11 rounded-full border-2 flex items-center justify-center" style={{ borderColor: "var(--accent)", boxShadow: "0 0 12px rgba(124,196,255,0.6)" }}><span className="display font-bold text-lg" style={{ color: "var(--ink-strong)" }}>P</span></div>
                  <div className="flex flex-col gap-0.5 text-[11px] tracking-[0.12em]"><span style={{ color: "var(--ink-strong)" }}>PHIL</span><span style={{ color: "var(--muted)" }}>RECOVERY — · DOC</span></div>
                </>}
              </div>
              <div className="order-1 lg:order-2 w-full max-w-2xl justify-self-center min-w-0">{!minimal && <Objective />}</div>
              <div className="order-3 flex gap-2 lg:justify-end">
                <button className="btn btn-sm" onClick={toggleMinimal} aria-pressed={minimal} title={minimal ? "Bring back the panels, towers and goals" : "Just the clock, the orb and the conversation"}>{minimal ? "Full" : "Minimal"}</button>
                <button className="btn btn-sm" onClick={toggle}>{power}Display off</button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-end pb-24 gap-4">
            {!background && <span className="text-[10px] tracking-[0.16em] uppercase" style={{ color: "var(--dim)" }}>Joi's skyline · display off · <Link href="/settings#display" style={{ color: "var(--accent)" }}>set a picture</Link></span>}
            <button className="btn btn-sm" onClick={toggle} style={background ? { background: "rgba(5,12,32,0.55)", backdropFilter: "blur(4px)" } : undefined}>{power}Display on</button>
          </div>
        )}
      </div>
    </Shell>
  );
}
