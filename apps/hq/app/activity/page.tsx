"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, fmtTime } from "@/lib/api";
import type { ActivityEntry } from "@/lib/types";

const KIND: Record<string, string> = { run: "var(--accent)", delegate: "var(--gold)", approval: "var(--amber)", decision: "var(--green)", schedule: "var(--muted)", system: "var(--muted)", error: "var(--red)", memory: "#B98CFF" };

export default function ActivityPage() {
  const { state, activity } = useLive();
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState("");
  const [rows, setRows] = useState<ActivityEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!q && !agent) { setRows(null); return; }
    const t = setTimeout(() => api<{ entries: ActivityEntry[] }>(`/api/activity?q=${encodeURIComponent(q)}&agent=${encodeURIComponent(agent)}&limit=300`).then((r) => setRows(r.entries)).catch(() => undefined), 200);
    return () => clearTimeout(t);
  }, [q, agent]);

  const list = rows ?? activity;
  const name = (id: string) => state?.agents.find((a) => a.id === id)?.name ?? id;

  return (
    <Shell>
      <div className="max-w-4xl w-full mx-auto p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>ACTIVITY LOG</h1>
          <input className="input h-9 w-56" placeholder="Search what, when, why" aria-label="Search the log" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input h-9 w-44" aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Every agent</option>
            {state?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Who did what, when and why. Tap a row for the prompt and the reply.</p>
        <table className="tbl">
          <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={3} className="text-center py-8" style={{ color: "var(--muted)" }}>Quiet so far.</td></tr>}
            {list.map((e) => (
              <tr key={e.id} onClick={() => setOpen(open === e.id ? null : e.id)} style={{ cursor: e.detail ? "pointer" : "default" }}>
                <td className="whitespace-nowrap" style={{ color: "var(--muted)" }}>{fmtTime(e.at)}</td>
                <td className="whitespace-nowrap"><span style={{ color: state?.ventures[state.agents.find((a) => a.id === e.agentId)?.venture ?? "root"]?.color }}>{name(e.agentId)}</span><br /><span className="text-[10px] tracking-[0.12em] uppercase" style={{ color: KIND[e.kind] }}>{e.kind}</span></td>
                <td>
                  {e.summary}
                  {open === e.id && e.detail && <pre className="mt-2 p-2 text-[11px] whitespace-pre-wrap overflow-x-auto" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--line)", maxHeight: 320, overflowY: "auto" }}>{Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v, null, 1)}`).join("\n\n")}</pre>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
