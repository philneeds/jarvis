"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useLive } from "@/lib/live";
import { post, fmtTime } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";
import { Md } from "./Md";
import { useVoice } from "@/lib/voice";

const QUICK = ["/brief", "/status", "/approvals", "/usage", "/pause", "/condense", "/help"];

type Recognition = { start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; lang: string; interimResults: boolean; continuous: boolean };

function speech(): Recognition | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return C ? new C() : null;
}

export function Chat({ compact, initial }: { compact?: boolean; initial?: string }) {
  const { state, messages, setMessages, streams } = useLive();
  const [text, setText] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const voice = useVoice({ onHeard: async () => undefined });
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<Recognition | null>(null);
  const [suggest, setSuggest] = useState<string[]>([]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages, busy]);

  const send = async (t = text) => {
    const line = t.trim();
    if (!line || busy) return;
    setText(""); setSuggest([]); setBusy(true); setError(undefined);
    try {
      const r = await post<{ messages: ChatMessage[] }>("/api/chat", { text: line });
      setMessages((m) => { const ids = new Set(m.map((x) => x.id)); return [...m, ...r.messages.filter((x) => !ids.has(x.id))]; });
      if (readAloud) { const reply = [...r.messages].reverse().find((m) => m.role !== "phil" && m.role !== "system"); if (reply) void voice.speak(reply.text); }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); inputRef.current?.focus(); }
  };

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void send(); };
  const onChange = (v: string) => {
    setText(v);
    const m = v.match(/(?:^|\s)@([\w.-]*)$/);
    if (m && state) {
      const q = m[1]!.toLowerCase();
      setSuggest(state.agents.filter((a) => a.id !== "interface" && (a.id.startsWith(q) || a.name.toLowerCase().startsWith(q))).slice(0, 6).map((a) => a.id));
    } else if (v.startsWith("/") && !v.includes(" ")) {
      setSuggest(QUICK.filter((c) => c.startsWith(v)));
    } else setSuggest([]);
  };
  const pick = (s: string) => {
    if (s.startsWith("/")) { setText(s + " "); }
    else setText(text.replace(/@[\w.-]*$/, `@${s} `));
    setSuggest([]); inputRef.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Tab" && suggest[0]) { e.preventDefault(); pick(suggest[0]); } };

  const mic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const r = speech();
    if (!r) { setError("Voice input isn't available in this browser."); return; }
    recRef.current = r; r.lang = "en-US"; r.interimResults = true; r.continuous = false;
    r.onresult = (e) => { const t = Array.from(e.results).map((x) => x[0]?.transcript ?? "").join(" "); setText(t); };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    setListening(true); r.start();
  };

  const name = (m: ChatMessage) => m.role === "phil" ? "PHIL" : m.role === "jarvis" ? "JARVIS" : m.role === "system" ? "HQ" : (state?.agents.find((a) => a.id === m.agentId)?.name ?? m.agentId ?? "AGENT").toUpperCase();
  const color = (m: ChatMessage) => m.role === "phil" ? "var(--amber)" : m.role === "jarvis" ? "var(--accent)" : m.role === "system" ? "var(--muted)" : (state ? state.ventures[state.agents.find((a) => a.id === m.agentId)?.venture ?? "root"]?.color : "var(--accent)");

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div ref={listRef} className="scroll flex-1 min-h-0 p-4 flex flex-col gap-3" aria-live="polite">
        {messages.length === 0 && <p className="msg msg-system">Say something to Jarvis. Use @name to talk to an agent, / for commands.</p>}
        {messages.slice(compact ? -30 : undefined).map((m) => (
          <div key={m.id} className={`msg ${m.role === "phil" ? "msg-phil" : m.role === "system" ? "msg-system" : ""}`} style={m.role === "agent" || m.role === "jarvis" ? { borderColor: `color-mix(in srgb, ${color(m)} 45%, transparent)` } : undefined}>
            {m.role !== "system" && (
              <span className="who" style={{ color: color(m) }}>
                <span>{name(m)}{m.via?.length ? <span style={{ color: "var(--muted)" }}> · via {m.via.join(", ")}</span> : null}</span>
                <span style={{ color: "var(--dim)", letterSpacing: 0 }}>{fmtTime(m.at)}</span>
              </span>
            )}
            {m.role === "phil" ? m.text : <Md text={m.text} />}
          </div>
        ))}
        {Object.entries(streams).filter(([, v]) => Date.now() - v.at < 120_000).map(([id, v]) => {
          const a = state?.agents.find((x) => x.id === v.agentId);
          const c = v.agentId === "jarvis" ? "var(--accent)" : state?.ventures[a?.venture ?? "root"]?.color ?? "var(--accent)";
          return <div key={id} className="msg" style={{ borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, opacity: 0.85 }}><span className="who" style={{ color: c }}><span>{(a?.name ?? v.agentId).toUpperCase()} · writing</span></span><Md text={v.text} /></div>;
        })}
        {busy && Object.keys(streams).length === 0 && <div className="msg" style={{ color: "var(--muted)" }}><span className="who" style={{ color: "var(--accent)" }}>JARVIS</span>thinking…</div>}
      </div>
      <form onSubmit={onSubmit} className="p-3 flex flex-col gap-2 border-t" style={{ borderColor: "var(--line)", background: "rgba(5,12,32,0.7)" }}>
        {!compact && (
          <div className="flex flex-wrap gap-1.5">
            {QUICK.map((q) => <button key={q} type="button" className="btn btn-sm" onClick={() => (q === "/pause" ? pick(q) : void send(q))}>{q}</button>)}
          </div>
        )}
        {suggest.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="listbox" aria-label="Suggestions">
            {suggest.map((s) => <button key={s} type="button" role="option" aria-selected={false} className="btn btn-sm" onClick={() => pick(s)}>{s.startsWith("/") ? s : `@${s}`}</button>)}
          </div>
        )}
        {error && <p className="text-[12px]" style={{ color: "var(--red)" }}>{error}</p>}
        <div className="flex gap-2">
          <label htmlFor="cmd" className="sr-only">Talk to Jarvis</label>
          <div className="input flex items-center gap-2 flex-1">
            <span style={{ color: "var(--accent)" }}>&gt;_</span>
            <input ref={inputRef} id="cmd" className="flex-1 min-w-0 bg-transparent border-0 outline-none h-full" placeholder="Talk to Jarvis, @ an agent, / for commands" value={text} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} autoComplete="off" enterKeyHint="send" />
          </div>
          <button type="button" className="btn w-11 px-0 flex-none" onClick={mic} aria-label={listening ? "Stop listening" : "Speak to Jarvis"} aria-pressed={listening} style={listening ? { borderColor: "var(--amber)", color: "var(--amber)" } : undefined}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
          <button type="button" className={`btn w-11 px-0 flex-none ${readAloud ? "btn-primary" : ""}`} onClick={() => { if (voice.speaking) voice.stopSpeaking(); setReadAloud(!readAloud); }} aria-pressed={readAloud} aria-label={readAloud ? "Stop reading replies aloud" : "Read replies aloud"} title={readAloud ? "Voice on" : "Voice off"}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>
          </button>
          <button className="btn btn-primary w-11 px-0 flex-none" disabled={busy || !text.trim()} aria-label="Send">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </form>
    </div>
  );
}
