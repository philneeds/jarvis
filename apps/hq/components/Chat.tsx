"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useLive } from "@/lib/live";
import { fmtTime } from "@/lib/api";
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
  const { state, messages, streams, send: submit } = useLive();
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
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [away, setAway] = useState(false);   // scrolled up, away from the latest
  const stick = useRef(true);                // follow new messages only while at the bottom

  const ql = q.trim().toLowerCase();
  useEffect(() => {
    if (ql) return;
    const last = messages[messages.length - 1];
    if (stick.current || last?.role === "phil") { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); stick.current = true; setAway(false); }
  }, [messages, busy, ql]);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = gap < 80;
    setAway(gap > 160);
  };
  const toLatest = () => { const el = listRef.current; if (!el) return; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); stick.current = true; setAway(false); };
  const copy = async (m: ChatMessage) => {
    try { await navigator.clipboard.writeText(m.text); }
    catch {
      // Older browsers or a non-secure origin: fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = m.text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } finally { ta.remove(); }
    }
    setCopied(m.id);
    setTimeout(() => setCopied((c) => (c === m.id ? null : c)), 1500);
  };
  // An ack with no final yet means Jarvis is still working on something.
  const lastIsAck = (() => { const acks = messages.filter((m) => m.kind === "ack"); const last = acks[acks.length - 1]; return !!last && Date.now() - Date.parse(last.at) < 6 * 60_000 && !messages.some((m) => m.kind === "final" && m.replyTo === last.replyTo); })();

  const send = async (t = text) => {
    const line = t.trim();
    if (!line || busy) return;
    setText(""); setSuggest([]); setBusy(true); setError(undefined);
    try {
      const { ack, final } = await submit(line);
      const first = await ack;                       // "on it" lands in seconds; the box frees up here
      setBusy(false); inputRef.current?.focus();
      if (readAloud && first) void voice.speak(first.text);
      const answer = await final;                    // the real answer streams in later; speak it if asked
      if (readAloud && answer && answer.id !== first?.id) void voice.speak(answer.text);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
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

  const lastPhil = [...messages].reverse().find((m) => m.role === "phil");
  const shown = ql ? messages.filter((m) => m.text.toLowerCase().includes(ql) || name(m).toLowerCase().includes(ql)) : messages.slice(compact ? -30 : undefined);

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {!compact && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-2">
          <input type="search" className="input h-9 flex-1" placeholder="Search the conversation" aria-label="Search the conversation" value={q}
            onChange={(e) => { setQ(e.target.value); if (!e.target.value) stick.current = true; }}
            onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); stick.current = true; } }} />
          {ql && <span className="text-[11px] whitespace-nowrap" style={{ color: "var(--muted)" }} aria-live="polite">{shown.length} found</span>}
          {q && <button type="button" className="btn btn-sm flex-none" onClick={() => { setQ(""); stick.current = true; }}>Clear</button>}
        </div>
      )}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={listRef} onScroll={onScroll} className="scroll flex-1 min-h-0 p-4 flex flex-col gap-3" aria-live={ql ? "off" : "polite"}>
        {messages.length === 0 && <p className="msg msg-system">Say something to Jarvis. Use @name to talk to an agent, / for commands.</p>}
        {ql && shown.length === 0 && <p className="msg msg-system">Nothing in this conversation matches &ldquo;{q.trim()}&rdquo;.</p>}
        {shown.map((m) => (
          <div key={m.id} className={`msg ${m.role === "phil" ? "msg-phil" : m.role === "system" ? "msg-system" : ""} ${m.kind === "ack" ? "msg-ack" : m.kind === "progress" ? "msg-progress" : ""}`} style={m.role === "agent" || m.role === "jarvis" ? { borderColor: `color-mix(in srgb, ${color(m)} 45%, transparent)` } : undefined}>
            {m.role !== "system" && (
              <span className="who" style={{ color: color(m) }}>
                <span>{name(m)}{m.via?.length ? <span style={{ color: "var(--muted)" }}> · via {m.via.join(", ")}</span> : null}</span>
                <span style={{ color: "var(--dim)", letterSpacing: 0 }}>{fmtTime(m.at)}</span>
              </span>
            )}
            {m.role === "phil" ? m.text : <Md text={m.text} />}
            {m.role !== "system" && (
              <div className="msg-actions">
                {m.id === lastPhil?.id && <button type="button" className="msg-act" disabled={busy} onClick={() => void send(m.text)} aria-label="Ask that again">Ask again</button>}
                <button type="button" className="msg-act" onClick={() => void copy(m)} aria-label={`Copy ${m.role === "phil" ? "your" : `${name(m).toLowerCase()}'s`} message`}>{copied === m.id ? "Copied" : "Copy"}</button>
              </div>
            )}
          </div>
        ))}
        {!ql && Object.entries(streams).filter(([, v]) => Date.now() - v.at < 120_000).map(([id, v]) => {
          const a = state?.agents.find((x) => x.id === v.agentId);
          const c = v.agentId === "jarvis" ? "var(--accent)" : state?.ventures[a?.venture ?? "root"]?.color ?? "var(--accent)";
          return <div key={id} className="msg" style={{ borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, opacity: 0.85 }}><span className="who" style={{ color: c }}><span>{(a?.name ?? v.agentId).toUpperCase()} · writing</span></span><Md text={v.text} /></div>;
        })}
        {!ql && busy && Object.keys(streams).length === 0 && <div className="msg" style={{ color: "var(--muted)" }}><span className="who" style={{ color: "var(--accent)" }}>JARVIS</span>thinking…</div>}
        {!ql && !busy && Object.keys(streams).length === 0 && lastIsAck && <p className="msg msg-system">still working · the answer will appear here</p>}
      </div>
      {away && !ql && <button type="button" className="btn btn-sm btn-primary absolute left-1/2 -translate-x-1/2 bottom-3" style={{ boxShadow: "0 4px 18px rgba(0,0,0,0.5)" }} onClick={toLatest}>Jump to latest ↓</button>}
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
