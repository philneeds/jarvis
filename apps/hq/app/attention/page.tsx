"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { ApprovalsPanel, type ApprovalsTab } from "@/components/ApprovalsPanel";
import { TodoPanel } from "@/components/TodoPanel";

type Section = "approve" | "todo";

/** Everything waiting on Phil, in one place: drafts to approve first, then the things only he can do. */
export default function NeedsYouPage() {
  const { state, error, pending, attention } = useLive();
  const [approvalsTab, setApprovalsTab] = useState<ApprovalsTab>("pending");
  const [active, setActive] = useState<Section | null>(null);
  const toApprove = pending.length;
  const toDo = attention.filter((i) => i.status === "open").length;
  const total = toApprove + toDo;
  const loaded = state !== null;

  // Old links (/approvals?tab=decided, Telegram) open the Decided view.
  useEffect(() => { if (new URLSearchParams(window.location.search).get("tab") === "decided") setApprovalsTab("decided"); }, []);

  // #approve / #todo: follow the hash, and land on it again once the lists have loaded and pushed To do down the page.
  useEffect(() => {
    const read = () => { const h = window.location.hash.slice(1); setActive(h === "approve" || h === "todo" ? h : null); };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const h = window.location.hash.slice(1);
    if (h === "approve" || h === "todo") document.getElementById(h)?.scrollIntoView({ block: "start" });
  }, [loaded]);

  const summary = !loaded
    ? error ? `Can't reach Jarvis right now: ${error}` : "Checking what's waiting…"
    : total === 0 ? "Nothing waiting on you. You're clear."
    : `${total} waiting: ${[toApprove ? `${toApprove} to approve` : "", toDo ? `${toDo} to do` : ""].filter(Boolean).join(", ")}`;
  const jump = (s: Section, label: string, n: number) => (
    <a href={`#${s}`} aria-current={active === s ? "true" : undefined} onClick={() => setActive(s)} style={active === s ? { borderColor: "var(--accent)", color: "var(--ink-bright)", background: "rgba(60,130,255,0.25)" } : undefined}>
      {label}{n > 0 && <span className="badge">{n}</span>}
    </a>
  );

  return (
    <Shell>
      <div className="max-w-3xl w-full mx-auto p-4 flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: total > 0 ? "var(--amber)" : "var(--ink-bright)" }}>NEEDS YOU</h1>
          <p className="m-0 text-[13px]" role="status" aria-live="polite" style={{ color: !loaded && error ? "var(--red)" : total > 0 ? "var(--amber)" : "var(--muted)" }}>{summary}</p>
        </div>
        {/* Jump straight to either section; stays at the top while scrolling on a phone. */}
        <nav className="tabs sticky top-0 py-1.5 -my-1.5" aria-label="Sections" style={{ zIndex: 10, background: "rgba(5,12,32,0.92)", backdropFilter: "blur(6px)" }}>
          {jump("approve", "Approve", toApprove)}
          {jump("todo", "To do", toDo)}
        </nav>
        <ApprovalsPanel tab={approvalsTab} onTab={setApprovalsTab} />
        <div className="border-t" style={{ borderColor: "var(--line)" }} role="separator" />
        <TodoPanel />
      </div>
    </Shell>
  );
}
