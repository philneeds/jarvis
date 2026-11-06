"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Goal } from "@jarvis/core";
import { api, post, put } from "@/lib/api";
import { useLive } from "@/lib/live";
import { useUndo } from "@/lib/undo";

/**
 * Phil's goals: the primary objective up top, the rest in a dropdown, one bar for all of them. Stored by the server
 * (/api/goals), which also keeps a plain-words copy in memory [phil] goals so agents know them.
 */
export function Objective() {
  const { onEvent } = useLive();
  const showUndo = useUndo();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [err, setErr] = useState<string>();
  const [name, setName] = useState("");

  const load = () => api<{ goals: Goal[] }>("/api/goals").then((r) => setGoals(r.goals)).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  useEffect(() => onEvent((e) => { if (e.type === "goals") setGoals(e.goals); }), [onEvent]);

  const primary = goals.find((g) => g.primary);
  const others = goals.filter((g) => !g.primary);
  const pct = goals.length ? Math.round(goals.reduce((a, g) => a + (g.pct || 0), 0) / goals.length) : 0;

  const run = async (fn: () => Promise<{ goals: Goal[] }>) => {
    setErr(undefined);
    try { setGoals((await fn()).goals); return true; } catch (e) { setErr((e as Error).message); return false; }
  };
  const update = (g: Goal, patch: { name?: string; pct?: number; deadline?: string | null; primary?: true; benchmarksDone?: { done?: string[]; undone?: string[] } }) => run(() => put(`/api/goals/${g.id}`, patch));
  const remove = async (g: Goal) => {
    setErr(undefined);
    try {
      const r = await api<{ goals: Goal[]; undoId: string }>(`/api/goals/${g.id}`, { method: "DELETE" });
      setGoals(r.goals);
      showUndo(`Deleted goal “${g.name}”`, r.undoId, () => void load());
    } catch (e) { setErr((e as Error).message); }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (await run(() => post("/api/goals", { name: name.trim() }))) setName("");
  };

  if (edit) {
    return (
      <section className="panel-strong p-4 flex flex-col gap-3" aria-label="Edit goals">
        <div className="flex items-center justify-between gap-2"><span className="label">Goals</span><button className="btn btn-sm" onClick={() => setEdit(false)}>Done</button></div>
        {goals.length === 0 && <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>No goals yet. The first one you add is your primary objective.</p>}
        <div role="radiogroup" aria-label="Primary goal" className="flex flex-col gap-3">
          {goals.map((g) => <GoalRow key={g.id} goal={g} onUpdate={(p) => update(g, p)} onDelete={() => remove(g)} />)}
        </div>
        <form onSubmit={add} className="flex gap-2">
          <input className="input h-9 flex-1" placeholder={goals.length ? "Add another goal" : "Your main goal"} aria-label="New goal" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-sm btn-primary h-9" disabled={!name.trim()}>Add</button>
        </form>
        {err && <p className="m-0 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
      </section>
    );
  }

  // No goals yet: one line to set the first, not a big empty card.
  if (!goals.length) {
    return (
      <form onSubmit={add} className="flex gap-2 w-full" aria-label="Set your main goal">
        <input className="input h-10 flex-1 min-w-0" placeholder="Set your main goal" aria-label="Your main goal" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-sm btn-primary h-10" disabled={!name.trim()}>Set</button>
        {err && <span className="text-[12px] self-center" style={{ color: "var(--red)" }}>{err}</span>}
      </form>
    );
  }

  return (
    <section className="panel-strong p-4 flex flex-col gap-2" aria-label="Primary objective">
      <div className="flex items-center justify-between gap-2 text-[11px] tracking-[0.18em] uppercase">
        <span style={{ color: "var(--ink-strong)" }}>◉ Primary objective</span>
        <span className="flex items-center gap-2" style={{ color: "var(--muted)" }}>{primary?.deadline ? `Deadline ${primary.deadline}` : ""}<button className="btn btn-sm h-7" onClick={() => setEdit(true)} aria-label="Edit goals">Edit</button></span>
      </div>
      {primary ? (
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-3 w-full text-left bg-transparent border-0 p-0 cursor-pointer">
          <span className="display glow font-bold leading-[1.05] min-w-0 break-words" style={{ fontSize: 22, color: "#fff" }}>{primary.name}</span>
          <span className="ml-auto flex-none text-[10px] tracking-[0.12em] px-1.5 py-0.5 border" style={{ color: "var(--accent)", borderColor: "var(--accent-soft)" }}>+{others.length} {others.length === 1 ? "GOAL" : "GOALS"} {open ? "▴" : "▾"}</span>
        </button>
      ) : (
        <button onClick={() => setEdit(true)} className="w-full text-left bg-transparent border-0 p-0 cursor-pointer display glow font-bold leading-[1.05]" style={{ fontSize: 22, color: "#fff" }}>Set your main goal</button>
      )}
      <div className="flex justify-between text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}><span>{goals.length > 1 ? `All ${goals.length} goals` : primary ? `${primary.pct}% done` : "No goals yet"}{primary?.benchmarks?.length ? ` · ${primary.benchmarks.filter((b) => b.done).length} of ${primary.benchmarks.length} benchmarks` : ""}</span><span>{pct}%</span></div>
      <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      {open && primary && (
        <div className="flex flex-col gap-2 pt-2 border-t" style={{ borderColor: "var(--line)" }}>
          {[primary, ...others].map((g, i) => (
            <div key={g.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-3 text-[11px] tracking-[0.08em]">
                <span className="w-36 truncate" style={{ color: "var(--ink-strong)" }} title={g.name}>{g.name}</span>
                <div className="flex-1 h-[3px]" style={{ background: "rgba(124,196,255,0.15)" }}><div className="h-full" style={{ width: `${g.pct}%`, background: i === 0 ? "var(--accent)" : i === 1 ? "var(--green)" : "var(--gold)", boxShadow: `0 0 6px ${i === 0 ? "var(--accent)" : i === 1 ? "var(--green)" : "var(--gold)"}` }} /></div>
                <span className="w-11 text-right" style={{ color: "var(--muted)" }}>{g.pct}%</span>
              </div>
              {/* David's benchmarks: what moves this bar. Ticking one moves it by its weight. */}
              {g.benchmarks?.length ? (
                <ul className="m-0 pl-3 list-none flex flex-col gap-0.5">
                  {g.benchmarks.map((b) => (
                    <li key={b.id}>
                      <label className="flex items-center gap-2 text-[12px] cursor-pointer" style={{ color: b.done ? "var(--muted)" : "var(--ink)" }}>
                        <input type="checkbox" checked={b.done} onChange={(e) => void update(g, { benchmarksDone: e.target.checked ? { done: [b.id] } : { undone: [b.id] } })} />
                        <span className="flex-1 min-w-0" style={{ textDecoration: b.done ? "line-through" : undefined }}>{b.text}</span>
                        <span className="text-[10px]" style={{ color: "var(--dim)" }}>{b.weight}%</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : <span className="pl-3 text-[11px]" style={{ color: "var(--dim)" }}>David sets the benchmarks for this one.</span>}
            </div>
          ))}
          {others.length === 0 && <span className="text-[11px]" style={{ color: "var(--muted)" }}>Just the one goal. Add more under Edit.</span>}
        </div>
      )}
    </section>
  );
}

/** One goal in the editor: name and deadline save when you leave the field (or press Enter), progress when you let go of the slider. */
function GoalRow({ goal, onUpdate, onDelete }: { goal: Goal; onUpdate: (p: { name?: string; pct?: number; deadline?: string | null; primary?: true }) => Promise<boolean>; onDelete: () => void }) {
  const [name, setName] = useState(goal.name);
  const [pct, setPct] = useState(goal.pct);
  const [deadline, setDeadline] = useState(goal.deadline ?? "");
  useEffect(() => { setName(goal.name); setPct(goal.pct); setDeadline(goal.deadline ?? ""); }, [goal.name, goal.pct, goal.deadline]);

  const commitName = () => { if (name.trim() && name.trim() !== goal.name) void onUpdate({ name: name.trim() }); else setName(goal.name); };
  const commitDeadline = () => { if (deadline !== (goal.deadline ?? "")) void onUpdate({ deadline: deadline || null }); };
  const commitPct = (v: number) => { const n = Math.max(0, Math.min(100, Math.round(v))); setPct(n); if (n !== goal.pct) void onUpdate({ pct: n }); };

  return (
    <div className="flex flex-col gap-2 p-2.5 border" style={{ borderColor: goal.primary ? "var(--accent)" : "var(--line)" }}>
      <input className="input h-9" value={name} maxLength={160} aria-label={`Name of goal ${goal.name}`} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setName(goal.name); }} />
      <div className="flex items-center gap-2">
        <input type="range" min={0} max={100} step={5} value={pct} className="flex-1 min-w-0" aria-label={`Progress on ${goal.name}`}
          onChange={(e) => setPct(Number(e.target.value))} onPointerUp={(e) => commitPct(Number((e.target as HTMLInputElement).value))} onKeyUp={(e) => commitPct(Number((e.target as HTMLInputElement).value))} onBlur={(e) => commitPct(Number(e.target.value))} />
        <input type="number" min={0} max={100} className="input h-8 w-16 text-[12px]" value={pct} aria-label={`Percent done on ${goal.name}`} onChange={(e) => setPct(Number(e.target.value))} onBlur={(e) => commitPct(Number(e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <span className="text-[11px]" style={{ color: "var(--muted)" }}>%</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>
        <label className="flex items-center gap-1.5 cursor-pointer min-h-8">
          <input type="radio" name="primary-goal" checked={goal.primary} onChange={() => void onUpdate({ primary: true })} aria-label={`Make ${goal.name} the primary goal`} />
          {goal.primary ? <span style={{ color: "var(--accent)" }}>Primary</span> : "Make primary"}
        </label>
        <label className="flex items-center gap-1.5">Deadline
          <input type="date" className="input h-8 w-36 text-[11px] normal-case tracking-normal" value={deadline} aria-label={`Deadline for ${goal.name}`} onChange={(e) => setDeadline(e.target.value)} onBlur={commitDeadline} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </label>
        <button className="btn btn-sm btn-danger h-8 ml-auto" onClick={onDelete} aria-label={`Delete goal ${goal.name}`}>Delete</button>
      </div>
    </div>
  );
}
