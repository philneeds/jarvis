"use client";

import { useEffect, useState } from "react";
import { useLive } from "@/lib/live";
import { api, post, put, fmtTime } from "@/lib/api";
import type { Approval } from "@/lib/types";
import { MayneLimits } from "@/components/MayneLimits";

const KIND: Record<string, string> = { send: "var(--red)", post: "var(--sky, #5CC8F5)", money: "var(--gold)", strategy: "#FF6EC7", config: "var(--accent)", record: "var(--green)", other: "var(--muted)" };

/** The approve button says what it does. */
const ACTION_LABEL: Record<string, string> = {
  "gmail.send": "Send email", "gmail.archive": "Archive", "gmail.label": "Add label", "gmail.trash": "Move to trash",
  "calendar.create": "Add to calendar", "calendar.update": "Change event", "calendar.delete": "Remove event",
  "x.post": "Post to X", "x.reply": "Post reply", "x.dm": "Send DM",
  "trade.execute": "Place trade", "trade.close": "Close position", "strategy.enable": "Enable strategy", "memory.replace": "Apply",
};
/** Which payload fields are worth a line at the top, in order. */
const HEADLINE: Record<string, string[]> = {
  "gmail.send": ["to", "account", "subject"], "gmail.archive": ["account", "query", "max"], "gmail.label": ["account", "label", "query"], "gmail.trash": ["account", "query", "max"],
  "calendar.create": ["start", "end", "account"], "calendar.update": ["start", "end", "account"], "calendar.delete": ["title", "account"],
  "x.post": ["account"], "x.reply": ["account", "replyTo"], "x.dm": ["account", "to"],
  "trade.execute": ["symbol", "side", "sizeUsd", "strategy"], "trade.close": ["positionId", "pnlUsd"], "strategy.enable": ["name", "backtestReturn", "winRate", "maxDrawdown", "paperDays"],
};
const LABEL: Record<string, string> = { to: "To", account: "From", subject: "Subject", query: "Matching", max: "Up to", label: "Label", start: "Start", end: "End", title: "Event", replyTo: "Reply to", sizeUsd: "Size $", pnlUsd: "P&L $", positionId: "Position", backtestReturn: "Backtest", winRate: "Win rate", maxDrawdown: "Max drawdown", paperDays: "Paper days", symbol: "Symbol", side: "Side", strategy: "Strategy", name: "Name" };

export type ApprovalsTab = "pending" | "decided";

/** Every draft waiting on Phil (and, under Decided, what he did with the rest). Moved out of the old Approvals page so Needs you can show it as its Approve section, unchanged. */
export function ApprovalsPanel({ tab, id = "approve" }: { tab: ApprovalsTab; id?: string }) {
  const { state, pending, setPending } = useLive();
  const [decided, setDecided] = useState<Approval[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const [question, setQuestion] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [byAgent, setByAgent] = useState("");                                      // Decided: "" = everyone
  const [outcome, setOutcome] = useState<"" | "approved" | "edited" | "rejected">(""); // Decided: "" = every outcome

  useEffect(() => { if (tab === "decided") api<{ approvals: Approval[] }>("/api/approvals").then((r) => setDecided(r.approvals.filter((a) => a.status !== "pending"))).catch(() => undefined); }, [tab, pending.length]);

  const agentName = (id: string) => state?.agents.find((x) => x.id === id)?.name ?? id;
  const venture = (id: string) => state?.ventures[state.agents.find((x) => x.id === id)?.venture ?? "root"];
  const action = (a: Approval) => (typeof a.payload?.action === "string" ? a.payload.action : undefined);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const replace = (a: Approval) => setPending((p) => p.map((x) => (x.id === a.id ? a : x)));

  const decide = async (a: Approval, d: "approve" | "reject") => {
    setBusy(a.id); setError(null);
    try {
      await post(`/api/approvals/${a.id}/${d}`, { note: note[a.id] || undefined });
      setPending((p) => p.filter((x) => x.id !== a.id));
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const saveEdit = async (a: Approval) => {
    setBusy(a.id); setError(null);
    try {
      const r = await put<{ approval: Approval }>(`/api/approvals/${a.id}`, { body: draft });
      replace(r.approval); setEditing(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const ask = async (a: Approval) => {
    const q = (question[a.id] ?? "").trim();
    if (!q) return;
    setAsking(a.id); setError(null); setQuestion((s) => ({ ...s, [a.id]: "" }));
    try {
      const r = await post<{ approval: Approval }>(`/api/approvals/${a.id}/ask`, { question: q });
      replace(r.approval);
    } catch (e) { setError((e as Error).message); } finally { setAsking(null); }
  };

  const deciders = [...new Set(decided.map((a) => a.agentId))].sort((x, y) => agentName(x).localeCompare(agentName(y)));
  const filtered = decided.filter((a) => (!byAgent || a.agentId === byAgent) && (!outcome || a.status === outcome));
  const list = tab === "pending" ? pending : filtered;
  const OUTCOMES = [["", "All"], ["approved", "Approved"], ["edited", "Edited"], ["rejected", "Rejected"]] as const;

  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-4 scroll-mt-20">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${id}-title`} className="sr-only">{tab === "pending" ? "To approve" : "Decided"}</h2>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>{tab === "pending" ? "Nothing goes out until you press the button that names it." : "What you approved, edited or rejected."}</p>
      </div>
      {error && <div className="card text-[12px]" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{error}</div>}
      {tab === "decided" && decided.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter decisions">
          <select className="input h-9 w-auto min-w-40 flex-1 sm:flex-none" aria-label="Filter by agent" value={byAgent} onChange={(e) => setByAgent(e.target.value)}>
            <option value="">Every agent</option>
            {deciders.map((id) => <option key={id} value={id}>{agentName(id)}</option>)}
          </select>
          <div className="tabs flex-1 sm:flex-none" style={{ minWidth: 280 }}>
            {OUTCOMES.map(([v, label]) => <button key={v} aria-pressed={outcome === v} onClick={() => setOutcome(v)} style={outcome === v ? { borderColor: "var(--accent)", color: "var(--ink-bright)", background: "rgba(60,130,255,0.25)" } : undefined}>{label}</button>)}
          </div>
          <span className="text-[11px]" style={{ color: "var(--muted)" }} aria-live="polite">{filtered.length} of {decided.length}</span>
          {(byAgent || outcome) && <button className="btn btn-sm h-9" onClick={() => { setByAgent(""); setOutcome(""); }}>Clear</button>}
        </div>
      )}
      {tab === "decided" && decided.length > 0 && filtered.length === 0 && <div className="card text-center py-6" style={{ color: "var(--muted)" }}>No decisions match these filters.</div>}
      {list.length === 0 && (tab === "pending" || decided.length === 0) && <p className="m-0 text-[13px]" style={{ color: "var(--muted)" }}>{tab === "pending" ? "Nothing to approve." : "No decisions yet."}</p>}
      {list.map((a) => {
        const v = venture(a.agentId);
        const act = action(a);
        const who = agentName(a.agentId);
        const first = who.split(" ")[0];
        const isOpen = open.has(a.id);
        const isEditing = editing === a.id;
        // HQ worked out the effect from the action; when nothing can act, the button must not promise a send.
        const inert = !act || /^(No connector handles|Nothing happens)/.test(a.effect ?? "");
        const label = inert ? "Approve (records only)" : (ACTION_LABEL[act] ?? "Approve");
        const head = (act && HEADLINE[act] ? HEADLINE[act] : Object.keys(a.payload ?? {}).filter((k) => k !== "action" && k !== "body" && k !== "text")).map((k) => [k, a.payload?.[k]] as const).filter(([, val]) => ["string", "number", "boolean"].includes(typeof val)).slice(0, 5);
        const thread = a.thread ?? [];
        return (
          <article key={a.id} className="card flex flex-col gap-3" aria-label={a.title} style={{ borderColor: `color-mix(in srgb, ${v?.color ?? "var(--accent)"} 60%, transparent)`, boxShadow: a.status === "pending" ? `0 0 24px color-mix(in srgb, ${v?.color ?? "var(--accent)"} 18%, transparent)` : undefined }}>
            <div className="flex flex-wrap items-center gap-2 text-[11px] tracking-[0.16em] uppercase">
              <span style={{ color: v?.color }}>{v?.short} · {who}</span>
              <span className="px-1.5 border" style={{ color: KIND[a.kind], borderColor: KIND[a.kind] }}>{a.kind}</span>
              {a.original !== undefined && <span className="px-1.5 border" style={{ color: "var(--amber)", borderColor: "var(--amber)" }}>{a.editedBy === "agent" ? `revised by ${first}` : "edited by you"}</span>}
              <span className="ml-auto" style={{ color: "var(--dim)", letterSpacing: 0 }}>{fmtTime(a.at)}</span>
            </div>
            <h3 className="display font-bold text-2xl leading-tight m-0" style={{ color: "var(--ink-bright)" }}>{a.title}</h3>

            {/* What approving does: one line, worked out by HQ from the action, never by the agent. */}
            {a.status === "pending" && (
              <div className="border-l-2 pl-3 py-1 text-[12px] leading-relaxed" style={{ borderColor: act ? "var(--amber)" : "var(--muted)", color: "var(--ink)" }}>
                <span className="text-[10px] tracking-[0.14em] uppercase block" style={{ color: "var(--amber)" }}>If you press {label}</span>
                {a.effect ?? "Nothing happens on its own: approving only records your decision."}
              </div>
            )}
            {head.length > 0 && (
              <dl className="m-0 grid gap-x-4 gap-y-1 text-[12px]" style={{ gridTemplateColumns: "max-content 1fr" }}>
                {head.map(([k, val]) => <div key={k} className="contents"><dt className="text-[10px] tracking-[0.14em] uppercase self-center" style={{ color: "var(--muted)" }}>{LABEL[k] ?? k}</dt><dd className="m-0 break-words">{String(val)}</dd></div>)}
              </dl>
            )}

            {/* The thing that goes out. Edit changes this exact text. */}
            {isEditing ? (
              <>
                <textarea className="input py-2" style={{ minHeight: 160 }} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit the text that goes out" />
                <div className="grid grid-cols-2 gap-2">
                  <button className="btn" disabled={busy === a.id} onClick={() => setEditing(null)}>Cancel</button>
                  <button className="btn btn-primary" disabled={busy === a.id || !draft.trim()} onClick={() => saveEdit(a)}>Save changes (still waiting)</button>
                </div>
              </>
            ) : (
              <p className="m-0 text-[13px] whitespace-pre-wrap leading-relaxed">{a.body}</p>
            )}
            {(a.kind === "strategy" || a.kind === "money") && a.status === "pending" && <MayneLimits compact />}

            {a.status === "pending" && !isEditing && (
              <div className="grid grid-cols-4 gap-2">
                <button className="btn btn-danger" disabled={busy === a.id} onClick={() => decide(a, "reject")}>Reject</button>
                <button className="btn" disabled={busy === a.id} onClick={() => { setEditing(a.id); setDraft(a.body); }}>Edit</button>
                <button className="btn relative" aria-expanded={isOpen} onClick={() => toggle(a.id)} style={isOpen ? { borderColor: "var(--accent)" } : undefined}>{isOpen ? "Less" : "More"}{thread.length > 0 && !isOpen ? <span className="badge">{thread.length}</span> : null}</button>
                <button className="btn btn-primary" disabled={busy === a.id || asking === a.id} onClick={() => decide(a, "approve")}>{label}</button>
              </div>
            )}

            {/* More: what the agent saw, the details, and a word with the agent. */}
            {a.status === "pending" && isOpen && (
              <div className="flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--line)" }}>
                <section aria-label="Context">
                  <h4 className="m-0 mb-1 text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>What {first} saw</h4>
                  {a.context ? <p className="m-0 text-[12px] whitespace-pre-wrap leading-relaxed">{a.context}</p> : <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>{first} didn&apos;t include any. Ask below, for example &ldquo;what did they last say?&rdquo;</p>}
                </section>
                {a.original !== undefined && (
                  <details className="text-[12px]"><summary className="cursor-pointer text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{first}&apos;s original text</summary><p className="m-0 mt-1 whitespace-pre-wrap" style={{ color: "var(--muted)" }}>{a.original}</p></details>
                )}
                {a.payload && Object.keys(a.payload).length > head.length + 1 && (
                  <details className="text-[12px]"><summary className="cursor-pointer text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Every detail</summary><pre className="m-0 mt-1 text-[11px] whitespace-pre-wrap break-words" style={{ color: "var(--muted)" }}>{JSON.stringify(a.payload, null, 1)}</pre></details>
                )}
                <section aria-label="Questions" className="flex flex-col gap-2">
                  <h4 className="m-0 text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Ask {first} about this</h4>
                  {thread.map((m, i) => (
                    <div key={i} className="text-[12px] leading-relaxed border-l-2 pl-2" style={{ borderColor: m.from === "phil" ? "var(--accent)" : v?.color ?? "var(--green)" }}>
                      <span className="text-[10px] tracking-[0.14em] uppercase mr-2" style={{ color: "var(--muted)" }}>{m.from === "phil" ? "You" : first} · {fmtTime(m.at)}</span>
                      <span className="whitespace-pre-wrap">{m.text}</span>
                    </div>
                  ))}
                  {asking === a.id && <div className="text-[12px]" style={{ color: "var(--muted)" }}>{first} is answering…</div>}
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(a); }}>
                    <input className="input h-10 flex-1" placeholder={`Ask ${first} a question, or tell ${first} what to change`} aria-label={`Ask ${who}`} value={question[a.id] ?? ""} onChange={(e) => setQuestion((s) => ({ ...s, [a.id]: e.target.value }))} disabled={asking === a.id} />
                    <button className="btn" type="submit" disabled={asking === a.id || !(question[a.id] ?? "").trim()}>Ask</button>
                  </form>
                  <input className="input h-9" placeholder="Note to go with your decision (optional)" aria-label="Note" value={note[a.id] ?? ""} onChange={(e) => setNote((s) => ({ ...s, [a.id]: e.target.value }))} />
                </section>
              </div>
            )}

            {a.status !== "pending" && (
              <>
                <p className="m-0 text-[11px] tracking-[0.14em] uppercase" style={{ color: a.status === "rejected" ? "var(--red)" : "var(--green)" }}>{a.status === "edited" ? "approved with your edits" : a.status}{a.decidedAt ? ` · ${fmtTime(a.decidedAt)}` : ""}</p>
                {a.note && <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>{a.note}</p>}
                {thread.length > 0 && <details className="text-[12px]"><summary className="cursor-pointer text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{thread.length} message(s) with {first}</summary>{thread.map((m, i) => <p key={i} className="m-0 mt-1 whitespace-pre-wrap"><b>{m.from === "phil" ? "You" : first}:</b> {m.text}</p>)}</details>}
              </>
            )}
          </article>
        );
      })}
    </section>
  );
}
