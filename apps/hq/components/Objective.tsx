"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Goal { name: string; pct: number; deadline?: string }
interface Goals { primary: Goal; secondary: Goal[] }
const EMPTY: Goals = { primary: { name: "", pct: 0 }, secondary: [{ name: "", pct: 0 }, { name: "", pct: 0 }] };

/** Primary objective with a dropdown for the two secondary goals; one bar covers all three. Stored in memory [phil] goals. */
export function Objective() {
  const [goals, setGoals] = useState<Goals>(EMPTY);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Goals>(EMPTY);

  useEffect(() => {
    api<{ items: { key: string; value: string }[] }>("/api/memory?scope=phil").then((r) => {
      const g = r.items.find((i) => i.key === "goals");
      if (g) { try { const v = JSON.parse(g.value) as Goals; setGoals(v); setDraft(v); } catch { /* keep empty */ } }
    }).catch(() => undefined);
  }, []);

  const all = [goals.primary, ...goals.secondary].filter((g) => g.name);
  const pct = all.length ? Math.round(all.reduce((a, g) => a + (g.pct || 0), 0) / all.length) : 0;

  const save = async () => {
    await api("/api/memory", { method: "PUT", body: JSON.stringify({ scope: "phil", key: "goals", value: JSON.stringify(draft) }) });
    setGoals(draft); setEdit(false);
  };
  const setG = (i: number, patch: Partial<Goal>) => setDraft((d) => {
    if (i === 0) return { ...d, primary: { ...d.primary, ...patch } };
    const s = d.secondary.slice(); s[i - 1] = { ...s[i - 1]!, ...patch }; return { ...d, secondary: s };
  });

  if (edit) {
    return (
      <section className="panel-strong p-4 flex flex-col gap-3" aria-label="Edit goals">
        <span className="label">Goals</span>
        {[draft.primary, ...draft.secondary].map((g, i) => (
          <div key={i} className="flex gap-2 items-center">
            <input className="input flex-1" placeholder={i === 0 ? "Primary objective" : `Goal ${i + 1}`} value={g.name} onChange={(e) => setG(i, { name: e.target.value })} aria-label={i === 0 ? "Primary objective" : `Goal ${i + 1}`} />
            <input className="input w-20" type="number" min={0} max={100} value={g.pct} onChange={(e) => setG(i, { pct: Number(e.target.value) })} aria-label="Percent done" />
            {i === 0 && <input className="input w-36" type="date" value={g.deadline ?? ""} onChange={(e) => setG(i, { deadline: e.target.value })} aria-label="Deadline" />}
          </div>
        ))}
        <div className="flex gap-2 justify-end"><button className="btn btn-sm" onClick={() => { setDraft(goals); setEdit(false); }}>Cancel</button><button className="btn btn-sm btn-primary" onClick={save}>Save</button></div>
      </section>
    );
  }

  return (
    <section className="panel-strong p-4 flex flex-col gap-2" aria-label="Primary objective">
      <div className="flex justify-between text-[11px] tracking-[0.18em] uppercase"><span style={{ color: "var(--ink-strong)" }}>◉ Primary objective</span><span style={{ color: "var(--muted)" }}>{goals.primary.deadline ? `Deadline ${goals.primary.deadline}` : ""}</span></div>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-3 w-full text-left bg-transparent border-0 p-0 cursor-pointer">
        <span className="display glow font-bold leading-[1.05]" style={{ fontSize: 22, color: "#fff" }}>{goals.primary.name || "Set your main goal"}</span>
        <span className="ml-auto text-[10px] tracking-[0.12em] px-1.5 py-0.5 border" style={{ color: "var(--accent)", borderColor: "var(--accent-soft)" }}>+{goals.secondary.filter((g) => g.name).length} GOALS {open ? "▴" : "▾"}</span>
      </button>
      <div className="flex justify-between text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}><span>All {all.length || 3} goals</span><span>{pct}%</span></div>
      <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      {open && (
        <div className="flex flex-col gap-2 pt-2 border-t" style={{ borderColor: "var(--line)" }}>
          {goals.secondary.map((g, i) => (
            <div key={i} className="flex items-center gap-3 text-[11px] tracking-[0.08em]">
              <span className="w-36 truncate" style={{ color: "var(--ink-strong)" }}>{g.name || `Goal ${i + 2}`}</span>
              <div className="flex-1 h-[3px]" style={{ background: "rgba(124,196,255,0.15)" }}><div className="h-full" style={{ width: `${g.pct}%`, background: i === 0 ? "var(--green)" : "var(--gold)", boxShadow: `0 0 6px ${i === 0 ? "var(--green)" : "var(--gold)"}` }} /></div>
              <span className="w-11 text-right" style={{ color: "var(--muted)" }}>{g.pct}%</span>
            </div>
          ))}
          <button className="btn btn-sm self-end" onClick={() => { setDraft(goals); setEdit(true); }}>Edit goals</button>
        </div>
      )}
    </section>
  );
}
