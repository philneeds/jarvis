"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "@/components/Shell";
import { Clock } from "@/components/Clock";
import { Towers } from "@/components/Towers";
import { Objective } from "@/components/Objective";
import { Skyline } from "@/components/Skyline";
import { useLive } from "@/lib/live";
import { api, post, timeAgo } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";

export default function HomePage() {
  const { state, pending, activity, messages, setMessages } = useLive();
  const [on, setOn] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [money, setMoney] = useState<{ key: string; value: string }[]>([]);
  const [visual, setVisual] = useState<{ key: string; value: string } | null>(null);
  const [since, setSince] = useState<string>();

  useEffect(() => {
    try { setOn(localStorage.getItem("hq.display") !== "off"); setSince(localStorage.getItem("hq.lastSeen") ?? undefined); } catch { /* ignore */ }
    const mark = () => { try { localStorage.setItem("hq.lastSeen", new Date().toISOString()); } catch { /* ignore */ } };
    window.addEventListener("pagehide", mark);
    api<{ items: { key: string; value: string }[] }>("/api/memory?scope=venture:money").then((r) => setMoney(r.items.filter((i) => /net.worth|cash|strateg/i.test(i.key)).slice(0, 3))).catch(() => undefined);
    api<{ items: { key: string; value: string }[] }>("/api/memory?scope=agent:joi").then((r) => setVisual(r.items.find((i) => i.key.startsWith("visual")) ?? null)).catch(() => undefined);
    return () => window.removeEventListener("pagehide", mark);
  }, []);
  const toggle = () => { setOn(!on); try { localStorage.setItem("hq.display", on ? "off" : "on"); } catch { /* ignore */ } };

  const lastJarvis = [...messages].reverse().find((m) => m.role === "jarvis");
  const recommendation = lastJarvis?.text.split("\n").find((l) => l.trim())?.slice(0, 220) ?? "Say the word. I'm listening.";
  const errors = state?.agents.filter((a) => a.status === "error") ?? [];
  const needs = [
    ...pending.slice(0, 3).map((p) => ({ tag: state?.ventures[state.agents.find((a) => a.id === p.agentId)?.venture ?? "root"]?.short ?? p.agentId.toUpperCase(), color: state?.ventures[state.agents.find((a) => a.id === p.agentId)?.venture ?? "root"]?.color, text: p.title, href: "/approvals" })),
    ...errors.slice(0, 2).map((a) => ({ tag: a.name.toUpperCase(), color: "var(--red)", text: a.lastError?.slice(0, 80) ?? "error", href: `/web?agent=${a.id}` })),
  ];
  const sinceAt = since ? new Date(since).getTime() : 0;
  const changes = activity.filter((e) => e.kind !== "schedule" && new Date(e.at).getTime() > sinceAt).slice(0, 5);
  const quiet = activity.filter((e) => new Date(e.at).getTime() > sinceAt).length;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const line = text.trim(); if (!line || busy) return;
    setText(""); setBusy(true);
    try {
      const r = await post<{ messages: ChatMessage[] }>("/api/chat", { text: line });
      setMessages((m) => { const ids = new Set(m.map((x) => x.id)); return [...m, ...r.messages.filter((x) => !ids.has(x.id))]; });
    } finally { setBusy(false); }
  };

  const core = (
    <div className="flex flex-col items-center gap-4 w-full max-w-md">
      <div className={`core ${busy || state?.agents.some((a) => a.status === "working") ? "working" : ""} ${state?.status.level === "red" ? "red" : ""}`} aria-hidden="true">
        <i className="ring" /><i className="disc" /><i className="arc" /><i className="arc2" /><i className="dash" /><i className="dots" /><i className="glowc" />
        <span className="word">{busy ? "THINKING" : state?.status.killSwitch.all ? "PAUSED" : "LISTENING"}</span>
      </div>
      <p className="text-center text-[12px] leading-relaxed" style={{ color: "var(--ink-strong)" }}><span className="label">Jarvis ▸ </span>{recommendation}</p>
      <form onSubmit={send} className="flex gap-1.5 w-full">
        <label htmlFor="home-cmd" className="sr-only">Command Jarvis</label>
        <div className="input flex items-center gap-2 flex-1"><span style={{ color: "var(--accent)" }}>&gt;_</span><input id="home-cmd" className="flex-1 min-w-0 bg-transparent border-0 outline-none h-full" placeholder="Talk to Jarvis, @ an agent, / for commands" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="send" /></div>
        <Link href="/command" className="btn w-11 px-0 flex-none" aria-label="Open Command (voice, history)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg></Link>
        <button className="btn btn-primary w-11 px-0 flex-none" disabled={busy || !text.trim()} aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></button>
      </form>
    </div>
  );

  return (
    <Shell>
      <Skyline dim={on} />
      <div className="relative flex-1 flex flex-col p-4 md:p-6 gap-5" style={{ zIndex: 1 }}>
        {on ? (
          <>
            <div className="corner tl" /><div className="corner tr" /><div className="corner bl" /><div className="corner br" />
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-2 flex-1 md:flex-none md:w-72">
                <div className="flex items-baseline gap-3 text-[11px] tracking-[0.14em]">
                  <span className="display font-bold text-lg tracking-[0.08em]" style={{ color: "var(--ink-strong)" }}>LV {Math.max(1, Math.floor((activity.length + messages.length) / 50) + (state?.status.phase ?? 0))}</span>
                  <span style={{ color: "var(--muted)" }}>Phase {state?.status.phase ?? 0}</span>
                  <span className="ml-auto" style={{ color: "var(--amber)" }}>{state?.pendingApprovals ?? 0} waiting</span>
                </div>
                <div className="bar"><i style={{ width: `${Math.min(100, ((activity.length + messages.length) % 50) * 2)}%` }} /></div>
                <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{state?.status.text ?? "connecting"}</span>
              </div>
              <Clock since={since} />
            </div>

            <div className="grid gap-6 md:grid-cols-[300px_1fr_300px] md:items-start">
              <div className="flex flex-col gap-7 order-2 md:order-1">
                <section aria-label="Needs your attention" className="flex flex-col gap-2">
                  <span className="label label-amber">❬ Needs your attention · {pending.length + errors.length}</span>
                  {needs.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing. Enjoy it.</span>}
                  {needs.map((n, i) => <Link key={i} href={n.href} className="flex gap-2 text-[12px] leading-snug" style={{ color: "var(--ink-bright)" }}><span className="w-20 flex-none text-[11px]" style={{ color: n.color }}>{n.tag}</span><span>{n.text}</span></Link>)}
                  <Link href="/approvals" className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--amber)" }}>Open all ›</Link>
                </section>
                <section aria-label="Money pulse" className="flex flex-col gap-2">
                  <span className="label" style={{ color: "var(--gold)" }}>❬ Money pulse · Munger</span>
                  {money.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>Munger goes live in Phase 2. Until then: @munger for a read.</span>}
                  {money.map((m) => <div key={m.key} className="flex justify-between text-[12px]"><span style={{ color: "var(--muted)" }}>{m.key.replace(/[-_.]/g, " ").toUpperCase()}</span><span style={{ color: "var(--ink-bright)" }}>{m.value}</span></div>)}
                  <span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Mayne · {state?.status.killSwitch.trading ? "trading paused" : "all limits ok"}</span>
                </section>
                <section aria-label="Visuals from Joi" className="flex flex-col gap-2">
                  <span className="label">❬ Visuals · Joi</span>
                  <div className="panel h-40 flex items-center justify-center text-[11px] tracking-[0.14em] uppercase text-center px-4" style={{ color: "var(--ink-strong)", backgroundImage: "repeating-linear-gradient(135deg, rgba(124,196,255,0.08) 0 1px, transparent 1px 10px)" }}>
                    {visual ? <img src={visual.value} alt={visual.key} className="max-h-full max-w-full object-contain" /> : "Joi's first visual lands in Phase 2"}
                  </div>
                </section>
              </div>

              <div className="flex flex-col items-center order-1 md:order-2 md:pt-4">{core}</div>

              <div className="flex flex-col gap-7 order-3 md:items-end md:text-right">
                <Towers />
                <section aria-label="Since you left" className="flex flex-col gap-2 w-full md:items-end">
                  <span className="label">Since you left · {quiet ? `${quiet} ${quiet === 1 ? "thing" : "things"}` : "quiet"} ❭</span>
                  {changes.length === 0 && <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing moved.</span>}
                  {changes.map((c) => <div key={c.id} className="flex gap-2 text-[12px] leading-snug md:flex-row-reverse"><span className="w-20 flex-none text-[11px] md:text-right" style={{ color: state?.ventures[state.agents.find((a) => a.id === c.agentId)?.venture ?? "root"]?.color }}>{(state?.agents.find((a) => a.id === c.agentId)?.name ?? c.agentId).toUpperCase()}</span><span style={{ color: "var(--ink-bright)" }}>{c.summary.slice(0, 90)}</span><span className="hidden md:inline" style={{ color: "var(--dim)" }}>{timeAgo(c.at)}</span></div>)}
                  <Link href="/activity" className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--accent)" }}>Full log ›</Link>
                </section>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-[300px_1fr_300px] md:items-end mt-auto">
              <div className="flex items-center gap-3 order-2 md:order-1">
                <div className="w-11 h-11 rounded-full border-2 flex items-center justify-center" style={{ borderColor: "var(--accent)", boxShadow: "0 0 12px rgba(124,196,255,0.6)" }}><span className="display font-bold text-lg" style={{ color: "var(--ink-strong)" }}>P</span></div>
                <div className="flex flex-col gap-0.5 text-[11px] tracking-[0.12em]"><span style={{ color: "var(--ink-strong)" }}>PHIL</span><span style={{ color: "var(--muted)" }}>RECOVERY — · DOC (PHASE 3)</span></div>
              </div>
              <div className="order-1 md:order-2 md:max-w-md md:w-full md:justify-self-center"><Objective /></div>
              <div className="order-3 flex md:justify-end"><button className="btn btn-sm" onClick={toggle}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" /></svg>Display off</button></div>
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
