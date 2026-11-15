"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useLive } from "./live";
import { api, post, fmtTime, timeAgo } from "./api";
import { Md } from "@/components/Md";
import { approveLabel } from "@/components/ApprovalsPanel";
import type { Approval, AttentionItem } from "./types";

/**
 * A side panel for one thing on Phil's plate (a to-do or an approval): what it is, who's on it, and a conversation
 * about it with those agents. It slides in from the right and can be opened from anywhere with useTask().open.
 */
export type TaskRef = { kind: "todo" | "approval"; id: string };
const Ctx = createContext<{ open: (t: TaskRef) => void; close: () => void } | null>(null);

/** Money, trades and code ships are decided on the full card, where the limits and the whole proposal are in view. */
export const isHeavy = (a: Approval) => a.kind === "money" || a.kind === "strategy" || /^(trade|strategy|robinhood|payment|invoice|transfer|wallet|order)\.|^code\.ship$|^hq\.update$/.test(typeof a.payload?.action === "string" ? a.payload.action : "");

export function TaskProvider({ children }: { children: ReactNode }) {
  const [task, setTask] = useState<TaskRef | null>(null);
  const open = useCallback((t: TaskRef) => setTask(t), []);
  const close = useCallback(() => setTask(null), []);
  return <Ctx.Provider value={{ open, close }}>{children}{task && <TaskPanel task={task} onClose={close} />}</Ctx.Provider>;
}

export function useTask() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTask outside TaskProvider");
  return v;
}

function TaskPanel({ task, onClose }: { task: TaskRef; onClose: () => void }) {
  const { state, attention, pending, setPending, onEvent } = useLive();
  const [all, setAll] = useState<AttentionItem[] | null>(null); // includes finished ones, for a to-do ticked meanwhile
  const [agents, setAgents] = useState<string[]>([]);
  const [to, setTo] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const todo = task.kind === "todo" ? attention.find((i) => i.id === task.id) ?? all?.find((i) => i.id === task.id) : undefined;
  const appr = task.kind === "approval" ? pending.find((a) => a.id === task.id) : undefined;
  const name = (id?: string) => state?.agents.find((a) => a.id === id)?.name ?? id ?? "";
  const ventureOf = (agentId: string, v?: string) => state?.ventures[(v && v !== "root" ? v : state.agents.find((a) => a.id === agentId)?.venture ?? "root") as keyof NonNullable<typeof state>["ventures"]];

  useEffect(() => {
    if (task.kind !== "todo") { setAgents(appr ? [appr.agentId] : []); return; }
    api<{ agents: string[] }>(`/api/attention/${task.id}/agents`).then((r) => setAgents(r.agents)).catch(() => undefined);
    if (!attention.some((i) => i.id === task.id)) api<{ items: AttentionItem[] }>("/api/attention?all=1").then((r) => setAll(r.items)).catch(() => undefined);
  }, [task.kind, task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The live list drops a to-do once it's finished, so keep this one's updates here too: a finished to-do's
  // conversation, and one ticked on another device while this panel is open, used to go blank.
  useEffect(() => (task.kind === "todo" ? onEvent((e) => { if (e.type === "attention" && e.item.id === task.id) setAll((l) => [e.item, ...(l ?? []).filter((i) => i.id !== e.item.id)]); }) : undefined), [task.kind, task.id, onEvent]);
  useEffect(() => { if (!to && agents.length) setTo(agents[0]!); }, [agents, to]);
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, [onClose]);
  useEffect(() => { input.current?.focus(); }, [task.id]);

  const thread = (todo?.thread ?? appr?.thread?.map((m) => ({ ...m, agentId: m.from === "agent" ? appr.agentId : undefined })) ?? []) as { at: string; from: "phil" | "agent"; agentId?: string; text: string }[];
  const replying = todo?.replying ?? (asking && appr ? appr.agentId : undefined);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [thread.length, replying]);

  const send = async () => {
    const q = text.trim();
    if (!q || asking) return;
    setErr(undefined); setText(""); setAsking(true);
    try {
      if (task.kind === "todo") { const r = await post<{ item?: AttentionItem }>(`/api/attention/${task.id}/ask`, { question: q, agentId: to ?? undefined }); if (r?.item) setAll((l) => [r.item!, ...(l ?? []).filter((i) => i.id !== r.item!.id)]); }
      else { const r = await post<{ approval: Approval }>(`/api/approvals/${task.id}/ask`, { question: q }); setPending((p) => p.map((x) => (x.id === r.approval.id ? r.approval : x))); }
    } catch (e) { setErr((e as Error).message); setText(q); } finally { setAsking(false); }
  };
  const act = async (fn: () => Promise<unknown>, closeAfter = true) => { setBusy(true); setErr(undefined); try { await fn(); if (closeAfter) onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };

  const item = todo ?? appr;
  const v = item ? ventureOf(item.agentId, todo?.venture) : undefined;
  const finished = todo ? todo.status === "done" : !appr;

  return (
    <div className="task-wrap" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="task-panel" role="dialog" aria-label={item ? `About: ${item.title}` : "Task"} style={{ borderLeftColor: v?.color }}>
        <header className="task-head">
          <span className="task-tag" style={{ color: v?.color }}>{task.kind === "todo" ? "To do" : "Needs your OK"}{v ? ` · ${v.short}` : ""}</span>
          <button className="base-x" style={{ position: "static" }} onClick={onClose} aria-label="Close">✕</button>
        </header>
        {!item ? (
          <p className="m-0 p-4 text-[13px]" style={{ color: "var(--muted)" }}>This one isn&apos;t waiting any more{task.kind === "approval" ? ": it was decided" : ""}. <button className="msg-act" onClick={onClose}>Close</button></p>
        ) : (
          <>
            <div className="task-what">
              <h2 className="m-0 text-[17px] leading-snug" style={{ color: "var(--ink-bright)" }}>{item.title}</h2>
              <p className="m-0 text-[12px] leading-relaxed" style={{ color: "var(--ink)" }}>{todo ? todo.why || "No note." : appr!.effect ?? appr!.body.slice(0, 300)}</p>
              <span className="text-[11px]" style={{ color: "var(--dim)" }}>Raised by {name(item.agentId)} · {timeAgo(item.at)}{todo?.due ? ` · due ${todo.due}` : ""}{finished ? " · finished" : ""}</span>
            </div>
            <div className="task-thread" aria-live="polite">
              {thread.length === 0 && !replying && <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Ask anything about this: what&apos;s needed, what they&apos;d do, or tell them to go ahead. {task.kind === "todo" ? "They can act on it from here; anything that leaves HQ still comes to you first." : `${name(appr!.agentId)} answers on the card, and can revise it.`}</p>}
              {thread.map((m, i) => (
                <div key={i} className={`task-msg ${m.from === "phil" ? "me" : ""}`}>
                  <span className="task-who">{m.from === "phil" ? `You${m.agentId && agents.length > 1 ? ` → ${name(m.agentId).split(" ")[0]}` : ""}` : name(m.agentId)} · {fmtTime(m.at)}</span>
                  {m.from === "phil" ? <p className="m-0 whitespace-pre-wrap">{m.text}</p> : <Md text={m.text} />}
                </div>
              ))}
              {replying && <div className="task-msg"><span className="task-who">{name(replying)}</span><span className="working-dot" style={{ background: "var(--accent)" }} /> <span style={{ color: "var(--muted)" }}>is answering…</span></div>}
              <div ref={end} />
            </div>
            <div className="task-foot">
              {agents.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Talk to">
                  <span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Talk to</span>
                  {agents.map((id) => <button key={id} role="radio" aria-checked={to === id} className="vchip" onClick={() => setTo(id)} style={to === id ? { borderColor: "var(--accent)", color: "var(--ink-bright)", background: "rgba(60,130,255,0.2)" } : undefined}>{name(id)}</button>)}
                </div>
              )}
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
                <textarea ref={input} className="input py-2" rows={2} style={{ height: "auto", resize: "none" }} placeholder={`Message ${name(to ?? item.agentId).split(" ")[0]} about this`} aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
                <button className="btn btn-primary w-11 px-0 flex-none self-stretch" disabled={!text.trim() || asking} aria-label="Send">→</button>
              </form>
              {err && <p className="m-0 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
              <div className="flex flex-wrap gap-2">
                {todo && todo.status !== "done" && <>
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(() => post(`/api/attention/${todo.id}/done`))}>Done ✓</button>
                  <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => post(`/api/attention/${todo.id}/snoozed`, { days: 3 }))}>Snooze 3 days</button>
                </>}
                {todo && todo.status === "done" && <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => post(`/api/attention/${todo.id}/reopened`), false)}>Reopen</button>}
                {appr && (isHeavy(appr)
                  ? <Link className="btn btn-sm btn-primary" href="/attention#approve" onClick={onClose}>Review the full card ›</Link>
                  : <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(async () => { await post(`/api/approvals/${appr.id}/approve`, {}); setPending((p) => p.filter((x) => x.id !== appr.id)); })}>{approveLabel(appr)}</button>)}
                {appr && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void act(async () => { await post(`/api/approvals/${appr.id}/reject`, {}); setPending((p) => p.filter((x) => x.id !== appr.id)); })}>Reject</button>}
                {appr && !isHeavy(appr) && <Link className="btn btn-sm" href="/attention#approve" onClick={onClose}>Full card ›</Link>}
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
