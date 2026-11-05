"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useLive } from "@/lib/live";

/**
 * The last few turns of the conversation, compact, for the home screen. Acks and progress lines are dimmed,
 * a "still working" line shows while an answer is on its way, and the full log is one tap away.
 */
/** Characters of a long turn shown before "…" (about three lines at the home screen's width). */
const SHORT = 190;

/** Markdown stripped for the compact view; the full rendering lives on Command. */
function plain(md: string): string {
  const t = md.replace(/```[\s\S]*?```/g, " ").replace(/\*\*|__|`/g, "").replace(/^#{1,6}\s+/gm, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^\s*[-*•]\s+/gm, "· ").replace(/\n{2,}/g, "\n").trim();
  return t.length > 1200 ? t.slice(0, 1200) + "…" : t;
}

export function Transcript({ limit = 8, pendingText }: { limit?: number; pendingText?: string }) {
  const { state, messages } = useLive();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);   // one message shown in full at a time
  const recent = messages.slice(-limit);
  const acks = messages.filter((m) => m.kind === "ack");
  const lastAck = acks[acks.length - 1];
  const working = !!lastAck && Date.now() - Date.parse(lastAck.at) < 6 * 60_000 && !messages.some((m) => m.kind === "final" && m.replyTo === lastAck.replyTo);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [messages.length, pendingText, working, open]);
  const who = (m: (typeof messages)[number]) => (m.role === "phil" ? "You" : m.role === "jarvis" ? "Jarvis" : m.role === "system" ? "HQ" : state?.agents.find((a) => a.id === m.agentId)?.name ?? m.agentId ?? "Agent");
  const tone = (m: (typeof messages)[number]) => (m.role === "phil" ? "var(--accent)" : m.role === "system" ? "var(--muted)" : m.role === "jarvis" ? "var(--ink-strong)" : state?.ventures[state.agents.find((a) => a.id === m.agentId)?.venture ?? "root"]?.color ?? "var(--green)");
  return (
    <section aria-label="Conversation" className="w-full flex flex-col gap-1">
      <div ref={ref} className="flex flex-col gap-2 overflow-y-auto pr-1" style={{ maxHeight: 300, scrollbarWidth: "thin" }}>
        {recent.length === 0 && !pendingText && <p className="m-0 text-center text-[12px]" style={{ color: "var(--muted)" }}>Say the word. I&apos;m listening.</p>}
        {recent.map((m) => {
          const text = plain(m.text);
          const long = text.length > SHORT || text.includes("\n");
          const full = open === m.id;
          // Cut in code, not CSS: browsers disagree on the legacy line-clamp and some collapse it to nothing.
          const shown = long && !full ? text.replace(/\s*\n+\s*/g, " · ").slice(0, SHORT).replace(/\s+\S*$/, "") + " …" : text;
          return (
            <p key={m.id} className={`m-0 text-[12px] leading-relaxed whitespace-pre-line ${m.kind === "ack" || m.kind === "progress" ? "msg-ack" : ""} ${long ? "cursor-pointer" : ""}`} style={{ color: "var(--ink)" }} onClick={() => long && setOpen(full ? null : m.id)} title={long ? (full ? "Tap to shorten" : "Tap to read all of it") : undefined}>
              <span className="text-[10px] tracking-[0.14em] uppercase mr-2" style={{ color: tone(m) }}>{who(m)}</span>
              {shown}
            </p>
          );
        })}
        {pendingText && <p className="m-0 text-[12px] italic" style={{ color: "var(--amber)" }}><span className="text-[10px] tracking-[0.14em] uppercase mr-2 not-italic" style={{ color: "var(--accent)" }}>You</span>{pendingText}</p>}
        {working && <p className="m-0 text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--amber)" }}>still working · the answer lands here</p>}
      </div>
      <Link href="/command" className="self-end text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--accent)" }}>Full chat ›</Link>
    </section>
  );
}
