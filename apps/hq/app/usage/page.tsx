"use client";

import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";

export default function UsagePage() {
  const { state } = useLive();
  const name = (id: string) => state?.agents.find((a) => a.id === id)?.name ?? id;
  const color = (u: number) => (u >= 0.9 ? "var(--red)" : u >= 0.7 ? "var(--amber)" : "var(--accent)");
  return (
    <Shell>
      <div className="max-w-4xl w-full mx-auto p-4 flex flex-col gap-4">
        <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>USAGE</h1>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Each plan against its pool this week, per agent. Scouts back off at 70%, research holds at 90%, Jarvis and Stella&apos;s team always run. Pools are estimates until the plans are confirmed.</p>
        {state?.usage.plans.map((p) => (
          <section key={p.plan} className="card flex flex-col gap-3" aria-label={p.label}>
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="display font-semibold text-xl m-0" style={{ color: "var(--ink-bright)" }}>{p.label}</h2>
              <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{p.window}</span>
              <span className="ml-auto display text-xl" style={{ color: color(p.used) }}>{p.window === "manual" ? "—" : `${Math.round(p.used * 100)}%`}</span>
            </div>
            {p.window !== "manual" && <div className="bar"><i style={{ width: `${Math.round(p.used * 100)}%`, background: p.used >= 0.7 ? `repeating-linear-gradient(90deg, ${color(p.used)} 0 5px, transparent 5px 7px)` : undefined, boxShadow: `0 0 8px ${color(p.used)}` }} /></div>}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]" style={{ color: "var(--muted)" }}>
              <span>{p.runs} runs</span><span>{(p.inputTokens + p.outputTokens).toLocaleString()} tokens</span>{p.costUsd > 0 && <span>${p.costUsd.toFixed(2)} API fallback</span>}{p.throttled && <span style={{ color: "var(--amber)" }}>scouts paused</span>}
            </div>
            {p.perAgent.length > 0 && (
              <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Agent</th><th>Runs</th><th>Tokens</th></tr></thead>
                <tbody>{p.perAgent.slice(0, 12).map((a) => <tr key={a.agentId}><td>{name(a.agentId)}</td><td>{a.runs}</td><td>{(a.inputTokens + a.outputTokens).toLocaleString()}</td></tr>)}</tbody></table></div>
            )}
          </section>
        ))}
        <section className="card flex flex-col gap-2" aria-label="Providers">
          <span className="label">Providers</span>
          {state && Object.entries(state.providers).map(([id, s]) => <div key={id} className="flex items-center gap-2 text-[12px]"><span className={`dot ${s.ok ? "dot-working" : "dot-idle"}`} /><span>{id}</span><span style={{ color: "var(--muted)" }}>{s.ok ? "ready" : s.reason}</span></div>)}
        </section>
        <section className="card flex flex-col gap-2" aria-label="Schedules">
          <span className="label">Schedules</span>
          <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Agent</th><th>When</th><th>Task</th><th>Phase</th></tr></thead>
            <tbody>{state?.schedules.map((s) => <tr key={s.id} style={{ opacity: s.phase <= (state.status.phase ?? 0) ? 1 : 0.5 }}><td className="whitespace-nowrap">{name(s.agentId)}</td><td className="whitespace-nowrap">{s.when.replace("daily@", "daily ").replace("weekly:", "weekly ").replace("every:", "every ") + (s.when.startsWith("every") ? " min" : "")}</td><td style={{ minWidth: 220 }}>{s.task === "brief" ? "Daily brief" : s.task === "condense" ? "Condense memory (Oscar)" : s.task}</td><td>{s.phase}</td></tr>)}</tbody></table></div>
        </section>
      </div>
    </Shell>
  );
}
