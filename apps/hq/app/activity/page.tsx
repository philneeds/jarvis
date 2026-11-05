"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, fmtTime } from "@/lib/api";
import { meaningful } from "@/lib/activity";
import type { ActivityEntry } from "@/lib/types";

const KIND: Record<string, string> = { run: "var(--accent)", delegate: "var(--gold)", approval: "var(--amber)", decision: "var(--green)", schedule: "var(--muted)", system: "var(--muted)", error: "var(--red)", memory: "#B98CFF" };
const RUNS_KEY = "hq.activity.runs";

export default function ActivityPage() {
  const { state, activity } = useLive();
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState("");
  // "Full log ›" links pass ?agent=<id>; open the log already filtered to that agent.
  useEffect(() => { const a = new URLSearchParams(window.location.search).get("agent"); if (a) setAgent(a); }, []);
  const [runs, setRuns] = useState(false);
  const [rows, setRows] = useState<{ entries: ActivityEntry[]; at: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { try { setRuns(localStorage.getItem(RUNS_KEY) === "on"); } catch { /* private window */ } }, []);
  const toggleRuns = () => { setRuns(!runs); try { localStorage.setItem(RUNS_KEY, runs ? "off" : "on"); } catch { /* private window */ } };

  // The live feed holds the latest entries worth reading. Searching, picking an agent or asking for runs goes to the server.
  useEffect(() => {
    if (!q && !agent && !runs) { setRows(null); return; }
    const at = new Date().toISOString();
    const t = setTimeout(() => api<{ entries: ActivityEntry[] }>(`/api/activity?q=${encodeURIComponent(q)}&agent=${encodeURIComponent(agent)}&limit=300${runs ? "" : "&exclude=run"}`).then((r) => setRows({ entries: r.entries, at })).catch(() => undefined), 200);
    return () => clearTimeout(t);
  }, [q, agent, runs]);

  const ql = q.trim().toLowerCase();
  const fits = (e: ActivityEntry) => (runs || meaningful(e)) && (!agent || e.agentId === agent) && (!ql || e.summary.toLowerCase().includes(ql) || e.agentId.includes(ql));
  // Entries that arrived over the websocket since the server answered stay on top, so the page keeps moving.
  const list = rows ? [...activity.filter((e) => e.at > rows.at && fits(e) && !rows.entries.some((x) => x.id === e.id)), ...rows.entries] : activity.filter(fits);
  const name = (id: string) => state?.agents.find((a) => a.id === id)?.name ?? id;
  const filtered = Boolean(q || agent);

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
          <button type="button" className="btn btn-sm h-9" aria-pressed={runs} onClick={toggleRuns} style={runs ? { borderColor: "var(--accent)", background: "rgba(60,130,255,0.25)", color: "var(--ink-bright)" } : undefined}>
            <span aria-hidden="true" className="inline-flex items-center justify-center w-3.5 h-3.5 border" style={{ borderColor: "var(--accent-soft)", background: runs ? "var(--accent)" : "transparent", color: "#06112B", fontSize: 10 }}>{runs ? "✓" : ""}</span>
            Show agent runs
          </button>
        </div>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>{runs ? "Everything, including one line per agent run. Tap a run for its prompt and reply." : "Hand-offs, approvals and decisions, errors, memory changes and scheduled jobs. The line each agent run leaves is hidden; Show agent runs brings those back."}</p>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>
              {list.length === 0 && (
                <tr><td colSpan={3} className="text-center py-8" style={{ color: "var(--muted)" }}>
                  {filtered ? <>Nothing matches. Clear the search or pick Every agent{runs ? "" : ", or turn on Show agent runs"}.</>
                    : <>Nothing logged yet. Hand-offs, approvals and errors appear here once agents work; give one a task in <Link href="/command">Command</Link>.</>}
                </td></tr>
              )}
              {list.map((e) => (
                <tr key={e.id} onClick={() => setOpen(open === e.id ? null : e.id)} style={{ cursor: e.detail ? "pointer" : "default" }}>
                  <td className="whitespace-nowrap" style={{ color: "var(--muted)" }}>{fmtTime(e.at)}</td>
                  <td className="whitespace-nowrap"><span style={{ color: state?.ventures[state.agents.find((a) => a.id === e.agentId)?.venture ?? "root"]?.color }}>{name(e.agentId)}</span><br /><span className="text-[10px] tracking-[0.12em] uppercase" style={{ color: KIND[e.kind] }}>{e.kind}</span></td>
                  <td style={{ overflowWrap: "anywhere" }}>
                    {e.summary}
                    {open === e.id && e.detail && <pre className="mt-2 p-2 text-[11px] whitespace-pre-wrap overflow-x-auto" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--line)", maxHeight: 320, overflowY: "auto" }}>{Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v, null, 1)}`).join("\n\n")}</pre>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}
