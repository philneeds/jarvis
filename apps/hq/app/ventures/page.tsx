"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api } from "@/lib/api";
import { fmtMetric } from "@/components/Sparkline";
import type { Venture, AgentLive, MetricDef } from "@/lib/types";

interface Summary { venture: Venture; lead?: AgentLive; agents: number; live: number; status: string; pending: number; headline: (MetricDef & { latest?: number })[]; counts: Record<string, number> }

const ST: Record<string, string> = { working: "var(--st-working)", waiting: "var(--st-needs)", idle: "var(--st-idle)", error: "var(--st-error)", dormant: "var(--dim)" };

export default function VenturesPage() {
  const { ventureTick } = useLive();
  const [list, setList] = useState<Summary[]>([]);
  useEffect(() => { api<{ ventures: Summary[] }>("/api/ventures").then((r) => setList(r.ventures)).catch(() => undefined); }, [ventureTick]);
  return (
    <Shell>
      <div className="max-w-5xl w-full mx-auto p-4 flex flex-col gap-4">
        <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>VENTURES</h1>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>One district per venture. Tap one for its numbers, its board and its team. Agents fill these in as they work; you can edit anything.</p>
        {list.length === 0 && <div className="card text-center py-10" style={{ color: "var(--muted)" }}>Loading the districts…</div>}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {list.map((s) => (
            <Link key={s.venture.id} href={`/ventures/${s.venture.id}`} className="card flex flex-col gap-2 hover:border-[var(--accent)]" style={{ borderColor: `color-mix(in srgb, ${s.venture.color} 55%, transparent)`, color: "var(--ink)" }}>
              <div className="flex items-center gap-2">
                <span className="display font-bold text-lg tracking-[0.08em]" style={{ color: s.venture.color }}>{s.venture.short}</span>
                <span className="dot ml-auto" style={{ background: ST[s.status], boxShadow: s.status !== "idle" && s.status !== "dormant" ? `0 0 8px ${ST[s.status]}` : "none" }} title={s.status} />
              </div>
              <span className="text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>{s.lead ? `${s.lead.name} · ` : ""}{s.live}/{s.agents} live{s.pending ? ` · ${s.pending} waiting on you` : ""}</span>
              <div className="flex gap-4">
                {s.headline.map((m) => <div key={m.key} className="flex flex-col"><span className="display text-xl" style={{ color: "var(--ink-bright)" }}>{fmtMetric(m.latest, m.unit)}</span><span className="text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>{m.label}</span></div>)}
              </div>
              {Object.keys(s.counts).length > 0 && <span className="text-[11px]" style={{ color: "var(--muted)" }}>{Object.entries(s.counts).map(([k, n]) => `${n} ${n === 1 ? k : k.endsWith("y") ? k.slice(0, -1) + "ies" : k + "s"}`).join(" · ")}</span>}
            </Link>
          ))}
        </div>
      </div>
    </Shell>
  );
}
