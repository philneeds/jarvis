"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, fmtTime } from "@/lib/api";

type Report = { id: string; agentId: string; toId: string; scheduleId: string; at: string; text: string };

/** What came up the chain: the routine reports and hand-overs Phil doesn't get pushed, by day, to skim when he wants. */
export default function ReportsPage() {
  const { state } = useLive();
  const [reports, setReports] = useState<Report[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  useEffect(() => { api<{ reports: Report[] }>("/api/reports?hours=72").then((r) => setReports(r.reports)).catch(() => setReports([])); }, []);
  const name = (id: string) => (id === "jarvis" ? "Jarvis" : state?.agents.find((a) => a.id === id)?.name ?? id);
  const color = (id: string) => state?.ventures[state.agents.find((a) => a.id === id)?.venture ?? "root"]?.color ?? "var(--accent)";
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" });
  const shown = (reports ?? []).filter((r) => !agent || r.agentId === agent || r.toId === agent);
  const days = [...new Set(shown.map((r) => day(r.at)))];

  return (
    <Shell>
      <div className="max-w-4xl w-full mx-auto p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>REPORTS</h1>
          <select className="input h-9 w-44" aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Everyone</option>
            {state?.agents.filter((a) => (reports ?? []).some((r) => r.agentId === a.id || r.toId === a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <Link href="/brief" className="ml-auto text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--accent)" }}>Daily brief ›</Link>
        </div>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>What went up the chain in the last three days: each agent's routine report and who took it. Nothing here was pushed to you; Jarvis folds it into the brief and can answer from it. Tap a line to read the whole report.</p>
        {reports === null && <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Loading…</p>}
        {reports?.length === 0 && <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Nothing yet. The first reports land with tomorrow morning's routines.</p>}
        {days.map((d) => (
          <section key={d} className="flex flex-col gap-2" aria-label={d}>
            <h2 className="label m-0 font-normal">{d}</h2>
            {shown.filter((r) => day(r.at) === d).map((r) => (
              <article key={r.id} className="card flex flex-col gap-1 cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] tracking-[0.12em] uppercase">
                  <span style={{ color: color(r.agentId) }}>{name(r.agentId)}</span>
                  <span style={{ color: "var(--dim)" }}>→ {name(r.toId)}</span>
                  <span style={{ color: "var(--muted)", letterSpacing: 0, textTransform: "none" }}>{r.scheduleId}</span>
                  <span className="ml-auto" style={{ color: "var(--dim)", letterSpacing: 0 }}>{fmtTime(r.at)}</span>
                </div>
                <p className={`m-0 text-[13px] leading-relaxed whitespace-pre-wrap ${open === r.id ? "" : "line-clamp-2"}`} style={{ color: "var(--ink-bright)" }}>{open === r.id ? r.text : r.text.replace(/\s+/g, " ").slice(0, 240)}</p>
              </article>
            ))}
          </section>
        ))}
      </div>
    </Shell>
  );
}
