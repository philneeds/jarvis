"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, fmtTime, timeAgo } from "@/lib/api";
import type { ScheduleView } from "@jarvis/core";

/** Every routine in the web, by agent: what runs, when, whether it's on in this phase, last and next run. */
export default function SchedulesPage() {
  const { state } = useLive();
  const [list, setList] = useState<ScheduleView[] | null>(null);
  const [phase, setPhase] = useState(0);
  const [showOff, setShowOff] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { api<{ schedules: ScheduleView[]; phase: number }>("/api/schedules").then((r) => { setList(r.schedules); setPhase(r.phase); }).catch((e) => setError((e as Error).message)); }, []);

  const agent = (id: string) => state?.agents.find((a) => a.id === id);
  const color = (id: string) => state?.ventures[agent(id)?.venture ?? "root"]?.color ?? "var(--accent)";
  const groups = useMemo(() => {
    const shown = (list ?? []).filter((s) => showOff || s.active);
    const by = new Map<string, ScheduleView[]>();
    for (const s of shown) by.set(s.agentId, [...(by.get(s.agentId) ?? []), s]);
    // Agents whose next routine comes soonest first; routines not on yet last.
    const soonest = (xs: ScheduleView[]) => Math.min(...xs.map((x) => (x.nextRun ? Date.parse(x.nextRun) : Infinity)));
    return [...by.entries()].sort((a, b) => soonest(a[1]) - soonest(b[1]));
  }, [list, showOff]);
  const off = (list ?? []).filter((s) => !s.active).length;
  const on = (list ?? []).length - off;

  return (
    <Shell>
      <div className="max-w-4xl w-full mx-auto p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>SCHEDULES</h1>
          {list && <span className="text-[12px]" style={{ color: "var(--muted)" }}>{on} running in phase {phase}{off ? ` · ${off} start in a later phase` : ""}</span>}
          {off > 0 && <button type="button" className="btn btn-sm ml-auto" aria-pressed={showOff} onClick={() => setShowOff(!showOff)}>{showOff ? "Hide later phases" : "Show later phases"}</button>}
        </div>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Every daily, weekly and monthly routine, by agent. Times are Eastern. Change one on the agent&apos;s page; everything else they do is on demand.</p>
        {error && <div className="card text-[12px]" style={{ color: "var(--red)" }}>{error}</div>}
        {!list && !error && <div className="card text-center py-10" style={{ color: "var(--muted)" }}>Loading schedules…</div>}
        {list && groups.length === 0 && <div className="card text-center py-10" style={{ color: "var(--muted)" }}>Nothing runs on a schedule in this phase.</div>}
        {groups.map(([id, xs]) => (
          <section key={id} className="card flex flex-col gap-2" aria-label={agent(id)?.name ?? id} style={{ borderColor: `color-mix(in srgb, ${color(id)} 45%, transparent)` }}>
            <div className="flex items-baseline gap-3">
              <Link href={`/agents/${id}`} className="display font-semibold text-lg" style={{ color: color(id) }}>{agent(id)?.name ?? id}</Link>
              <span className="text-[11px]" style={{ color: "var(--muted)" }}>{agent(id)?.short}</span>
            </div>
            {xs.map((s) => (
              <div key={s.id} className="flex flex-col gap-1 border-t pt-2 first-of-type:border-t-0" style={{ borderColor: "var(--line)", opacity: s.active ? 1 : 0.6 }}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                  <b style={{ color: "var(--ink-bright)" }}>{s.whenText}</b>
                  {s.push && <span className="px-1.5 border text-[10px] tracking-[0.12em] uppercase" style={{ borderColor: "var(--accent-soft)", color: "var(--accent)" }}>to Telegram</span>}
                  {s.to && <span className="px-1.5 border text-[10px] tracking-[0.12em] uppercase" style={{ borderColor: "var(--line)", color: "var(--muted)" }} title="Reports to this agent, not you">→ {agent(s.to)?.name ?? s.to}</span>}
                  {s.custom && <span className="px-1.5 border text-[10px] tracking-[0.12em] uppercase" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>your schedule</span>}
                  {!s.active && <span className="px-1.5 border text-[10px] tracking-[0.12em] uppercase" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>starts in phase {s.phase}</span>}
                  <span className="ml-auto text-[11px]" style={{ color: "var(--dim)" }}>
                    {s.active ? <>{s.nextRun ? `next ${fmtTime(s.nextRun)}` : ""}{s.lastRun ? ` · last ran ${timeAgo(s.lastRun)}` : " · hasn't run yet"}</> : null}
                  </span>
                </div>
                <p className="m-0 text-[12px] leading-relaxed" style={{ color: "var(--ink)" }}>{s.summary}</p>
                {s.task !== s.summary && <details className="text-[11px]"><summary className="cursor-pointer" style={{ color: "var(--muted)" }}>details</summary><p className="m-0 mt-1 leading-relaxed" style={{ color: "var(--muted)" }}>{s.task}</p></details>}
              </div>
            ))}
          </section>
        ))}
      </div>
    </Shell>
  );
}
