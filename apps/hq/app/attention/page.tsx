"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { ApprovalsPanel } from "@/components/ApprovalsPanel";
import { TodoPanel } from "@/components/TodoPanel";

type Section = "approve" | "todo";

/**
 * Everything waiting on Phil: Approve (drafts) and To do (things only he can do), one tab at a time. The tab with
 * something in it comes first; one "Show finished" switch covers both.
 */
export default function NeedsYouPage() {
  const { state, error, pending, attention } = useLive();
  const toApprove = pending.length;
  const toDo = attention.filter((i) => i.status === "open").length;
  const loaded = state !== null;
  const [chosen, setChosen] = useState<Section | null>(null);
  const [finished, setFinished] = useState(false);

  // #approve / #todo (from the home screen, Telegram, old links) pick the tab; ?tab=decided opens finished approvals.
  useEffect(() => {
    const read = () => { const h = window.location.hash.slice(1); if (h === "approve" || h === "todo") setChosen(h); };
    read();
    if (new URLSearchParams(window.location.search).get("tab") === "decided") { setChosen("approve"); setFinished(true); }
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const active: Section = chosen ?? (toApprove > 0 ? "approve" : "todo");
  const order: Section[] = toApprove > 0 ? ["approve", "todo"] : ["todo", "approve"];
  const pick = (s: Section) => { setChosen(s); history.replaceState(null, "", `#${s}`); };

  const summary = !loaded
    ? error ? `Can't reach Jarvis right now: ${error}` : "Checking what's waiting…"
    : `${toDo} to do · ${toApprove} to approve`;

  return (
    <Shell>
      <div className="max-w-3xl w-full mx-auto p-4 flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: toDo + toApprove > 0 ? "var(--amber)" : "var(--ink-bright)" }}>NEEDS YOU</h1>
          <p className="m-0 text-[13px]" role="status" aria-live="polite" style={{ color: !loaded && error ? "var(--red)" : toDo + toApprove > 0 ? "var(--amber)" : "var(--muted)" }}>{summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sticky top-0 py-1.5 -my-1.5" style={{ zIndex: 10, background: "rgba(5,12,32,0.92)", backdropFilter: "blur(6px)" }}>
          <nav className="tabs flex-1 min-w-56" aria-label="Sections" role="tablist">
            {order.map((s) => {
              const n = s === "approve" ? toApprove : toDo;
              return (
                <button key={s} role="tab" aria-selected={active === s} aria-controls={s} onClick={() => pick(s)} style={active === s ? { borderColor: "var(--accent)", color: "var(--ink-bright)", background: "rgba(60,130,255,0.25)" } : undefined}>
                  {s === "approve" ? "Approve" : "To do"}{n > 0 && <span className="badge">{n}</span>}
                </button>
              );
            })}
          </nav>
          <label className="flex items-center gap-2 text-[11px] tracking-[0.12em] uppercase cursor-pointer min-h-9" style={{ color: finished ? "var(--ink-bright)" : "var(--muted)" }}>
            <input type="checkbox" checked={finished} onChange={(e) => setFinished(e.target.checked)} />
            Show finished
          </label>
        </div>
        <div role="tabpanel">
          {active === "approve" ? <ApprovalsPanel tab={finished ? "decided" : "pending"} /> : <TodoPanel showDone={finished} />}
        </div>
      </div>
    </Shell>
  );
}
