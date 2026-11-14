"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { useUndo } from "@/lib/undo";
import { api, post, put, fmtTime } from "@/lib/api";
import { HORIZONS, HORIZON_HINT, HORIZON_LABEL, LEVEL_NAME, horizonOf, useBase, type Horizon } from "@/lib/base";
import type { Goal } from "@jarvis/core";

/**
 * Goals in three horizons. A long-term goal is where Phil is headed; mid and short-term goals feed it; each goal's
 * benchmarks are the checkable steps. Meeting a benchmark is a trophy, and trophies on a venture's goals raise that
 * venture's level on the base. David keeps the benchmarks honest and picks today's three from all of it.
 */
export default function GoalsPage() {
  const { state } = useLive();
  const showUndo = useUndo();
  const { base, goals, setGoals, toggle, repick } = useBase();
  const [err, setErr] = useState<string>();
  const [editing, setEditing] = useState<string | null>(null);

  const ventures = state ? Object.values(state.ventures).filter((v) => v.id !== "root" && state.agents.some((a) => a.venture === v.id)) : [];
  const venture = (id?: string) => (id && state ? state.ventures[id as keyof typeof state.ventures] : undefined);
  const run = async (fn: () => Promise<{ goals: Goal[] }>) => { setErr(undefined); try { setGoals((await fn()).goals); return true; } catch (e) { setErr((e as Error).message); return false; } };
  const update = (g: Goal, patch: Record<string, unknown>) => run(() => put(`/api/goals/${g.id}`, patch));
  const remove = async (g: Goal) => {
    setErr(undefined);
    try {
      const r = await api<{ goals: Goal[]; undoId: string }>(`/api/goals/${g.id}`, { method: "DELETE" });
      setGoals(r.goals);
      showUndo(`Deleted goal “${g.name}”`, r.undoId, () => void api<{ goals: Goal[] }>("/api/goals").then((x) => setGoals(x.goals)));
    } catch (e) { setErr((e as Error).message); }
  };

  const today = base?.today.items ?? [];
  const trophies = [...(base?.trophies ?? [])].reverse();
  const levels = Object.entries(base?.levels ?? {}).sort((a, b) => b[1].hits - a[1].hits);

  return (
    <Shell>
      <div className="p-4 md:p-6 flex flex-col gap-6 max-w-[1400px] w-full mx-auto">
        <header className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <h1 className="display m-0 text-3xl font-bold tracking-[0.06em]" style={{ color: "var(--ink-strong)" }}>Goals</h1>
          <p className="m-0 text-[12px] flex-1 min-w-60" style={{ color: "var(--muted)" }}>Long term is where you&apos;re headed. Mid and short-term goals feed it. David gives each goal its benchmarks, ticks them on evidence, and picks today&apos;s three.</p>
          <Link href="/" className="btn btn-sm">Back to base ›</Link>
        </header>
        {err && <div className="card text-[12px]" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{err}</div>}

        <section aria-label="Today's three" className="card flex flex-col gap-2" style={{ borderColor: "var(--gold)" }}>
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="label m-0 font-normal" style={{ color: "var(--gold)" }}>Today&apos;s 3</h2>
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>{base?.today.by === "david" ? "David's pick" : base?.today.by === "phil" ? "your pick" : "HQ's pick, until David's 6:40 routine runs"}{base && base.streak > 0 ? ` · ${base.streak} day streak` : ""}</span>
            {today.length > 0 && <button className="btn btn-sm ml-auto" onClick={() => void repick()}>Pick again</button>}
          </div>
          {today.length === 0 && <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Nothing to pick from yet. Add a goal below and its next step shows up here.</p>}
          {today.map((x) => {
            const v = venture(x.venture);
            return <button key={x.id} className="base-todo" data-done={x.done} aria-pressed={x.done} onClick={() => void toggle(x.id)}><i aria-hidden="true" /><span>{x.text}{v && <span className="ml-2 text-[10px] tracking-[0.12em]" style={{ color: v.color }}>{v.short}</span>}</span></button>;
          })}
        </section>

        <div className="grid gap-4 lg:grid-cols-3 items-start">
          {HORIZONS.map((h) => {
            const list = goals.filter((g) => horizonOf(g) === h);
            return (
              <section key={h} aria-label={HORIZON_LABEL[h]} className="flex flex-col gap-3 min-w-0">
                <div className="flex items-baseline justify-between gap-2"><h2 className="label m-0 font-normal">{HORIZON_LABEL[h]} · {list.length}</h2><span className="text-[11px]" style={{ color: "var(--muted)" }}>{HORIZON_HINT[h]}</span></div>
                {list.length === 0 && <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>{h === "long" ? "No long-term goal yet. Start here: one or two per venture is plenty." : h === "mid" ? "Nothing for this quarter yet." : "Nothing for the next two weeks yet."}</p>}
                {list.map((g) => {
                  const v = venture(g.venture), parent = goals.find((x) => x.id === g.parent), kids = goals.filter((x) => x.parent === g.id);
                  const marks = g.benchmarks ?? [];
                  // A long-term goal with no benchmarks and nothing under it can't move: say so rather than show a flat bar.
                  const stalled = h === "long" && marks.length === 0 && kids.length === 0 && g.pct < 100;
                  return (
                    <article key={g.id} className="card flex flex-col gap-2" style={{ borderLeft: `3px solid ${v?.color ?? "var(--accent)"}` }}>
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <h3 className="m-0 text-[15px] leading-snug" style={{ color: "var(--ink-bright)" }}>{g.primary && <span title="Your primary goal" style={{ color: "var(--gold)" }}>★ </span>}{g.name}</h3>
                          <p className="m-0 text-[11px]" style={{ color: "var(--muted)" }}>
                            {v ? <span style={{ color: v.color }}>{v.short}</span> : "No venture"}{g.deadline ? ` · due ${g.deadline}` : ""}{parent ? ` · feeds “${parent.name}”` : ""}{kids.length ? ` · ${kids.length} goal${kids.length === 1 ? "" : "s"} feeding it` : ""}
                          </p>
                        </div>
                        <span className="text-[13px] flex-none" style={{ color: g.pct >= 100 ? "var(--green)" : "var(--ink-strong)" }}>{g.pct}%</span>
                        <button className="btn btn-sm flex-none" aria-expanded={editing === g.id} onClick={() => setEditing(editing === g.id ? null : g.id)}>{editing === g.id ? "Done" : "Edit"}</button>
                      </div>
                      <div className="bar"><i style={{ width: `${g.pct}%` }} /></div>
                      {stalled && <p className="m-0 text-[11px]" style={{ color: "var(--amber)" }}>Nothing is feeding this yet: no benchmarks and no shorter goal under it. Ask David for benchmarks, or add a mid-term goal that feeds it.</p>}
                      {marks.length > 0 && (
                        <ul className="m-0 p-0 list-none flex flex-col gap-1">
                          {marks.map((b) => <li key={b.id}><button className="base-todo" data-done={b.done} aria-pressed={b.done} onClick={() => void update(g, { benchmarksDone: b.done ? { undone: [b.id] } : { done: [b.id] } })}><i aria-hidden="true" /><span className="text-[12px]">{b.text}</span></button></li>)}
                        </ul>
                      )}
                      {editing === g.id && <GoalEditor goal={g} goals={goals} ventures={ventures} onUpdate={(p) => update(g, p)} onDelete={() => void remove(g)} />}
                    </article>
                  );
                })}
                <AddGoal horizon={h} goals={goals} ventures={ventures} onAdd={(body) => run(async () => { await post("/api/goals", body); return api<{ goals: Goal[] }>("/api/goals"); })} />
              </section>
            );
          })}
        </div>

        <section aria-label="Trophies" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-3"><h2 className="label m-0 font-normal">Trophies · {trophies.length}</h2><span className="text-[11px]" style={{ color: "var(--muted)" }}>A benchmark met is one, and finishing the goal is one more. A venture&apos;s level comes from the trophies on its goals: 1, 3, 6 and 10 reach levels 2 to 5.</span></div>
          {levels.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {levels.map(([id, lv]) => { const v = venture(id); return <span key={id} className="base-chip normal-case tracking-normal text-[12px]" style={{ borderColor: v?.color }}><b style={{ color: v?.color }}>{v?.short ?? id}</b>&nbsp;· level {lv.level} {LEVEL_NAME[lv.level]}{lv.next ? ` · ${lv.next - lv.hits} to go` : ""}</span>; })}
            </div>
          )}
          {trophies.length === 0 ? <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>None yet. The first benchmark you or David tick earns one, and the venture it belongs to starts to grow.</p> : (
            <ul className="m-0 p-0 list-none grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {trophies.slice(0, 30).map((t) => { const v = venture(t.venture); return (
                <li key={t.id} className="card flex items-start gap-3 py-2.5">
                  <span aria-hidden="true" className="flex-none mt-1 w-3 h-3 rotate-45" style={{ background: "var(--gold)", boxShadow: "0 0 8px var(--gold)" }} />
                  <span className="min-w-0 text-[12px]"><b style={{ color: "var(--ink-bright)" }}>{t.title}</b><br /><span style={{ color: "var(--muted)" }}>{t.kind === "goal" ? "Goal finished" : `Toward “${t.goalName}”`} · {v ? <span style={{ color: v.color }}>{v.short}</span> : "no venture"} · {fmtTime(t.at)}</span></span>
                </li>
              ); })}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  );
}

type V = { id: string; short: string };

function GoalEditor({ goal, goals, ventures, onUpdate, onDelete }: { goal: Goal; goals: Goal[]; ventures: V[]; onUpdate: (p: Record<string, unknown>) => Promise<boolean>; onDelete: () => void }) {
  const [name, setName] = useState(goal.name);
  const [mark, setMark] = useState("");
  // A goal can feed any other goal, but not itself or something that already feeds it.
  const canFeed = goals.filter((g) => g.id !== goal.id && g.parent !== goal.id);
  const addMark = async (e: FormEvent) => {
    e.preventDefault();
    if (!mark.trim()) return;
    if (await onUpdate({ benchmarks: [...(goal.benchmarks ?? []).map((b) => ({ text: b.text, weight: b.weight, done: b.done })), { text: mark.trim() }] })) setMark("");
  };
  return (
    <div className="flex flex-col gap-2 border-t pt-3 text-[12px]" style={{ borderColor: "var(--line)" }}>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name.trim() !== goal.name) void onUpdate({ name: name.trim() }); }}>
        <input className="input h-9 flex-1" aria-label="Goal name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-sm h-9" disabled={!name.trim() || name.trim() === goal.name}>Rename</button>
      </form>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1"><span style={{ color: "var(--muted)" }}>Horizon</span>
          <select className="input h-9" value={goal.horizon ?? ""} onChange={(e) => void onUpdate({ horizon: e.target.value || null })}><option value="">By its deadline ({HORIZON_LABEL[horizonOf({ deadline: goal.deadline })].toLowerCase()})</option>{HORIZONS.map((h) => <option key={h} value={h}>{HORIZON_LABEL[h]}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1"><span style={{ color: "var(--muted)" }}>Venture</span>
          <select className="input h-9" value={goal.venture ?? ""} onChange={(e) => void onUpdate({ venture: e.target.value || null })}><option value="">None</option>{ventures.map((v) => <option key={v.id} value={v.id}>{v.short}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1"><span style={{ color: "var(--muted)" }}>Deadline</span>
          <input type="date" className="input h-9" value={goal.deadline ?? ""} onChange={(e) => void onUpdate({ deadline: e.target.value || null })} />
        </label>
        <label className="flex flex-col gap-1"><span style={{ color: "var(--muted)" }}>Feeds</span>
          <select className="input h-9" value={goal.parent ?? ""} onChange={(e) => void onUpdate({ parent: e.target.value || null })}><option value="">Nothing</option>{canFeed.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        </label>
      </div>
      <form className="flex gap-2" onSubmit={addMark}>
        <input className="input h-9 flex-1" placeholder="Add a benchmark: something checkable" aria-label="New benchmark" value={mark} maxLength={200} onChange={(e) => setMark(e.target.value)} />
        <button className="btn btn-sm h-9" disabled={!mark.trim() || (goal.benchmarks?.length ?? 0) >= 12}>Add</button>
      </form>
      <div className="flex gap-2">
        {!goal.primary && <button className="btn btn-sm" onClick={() => void onUpdate({ primary: true })}>Make primary</button>}
        <button className="btn btn-sm btn-danger ml-auto" onClick={onDelete}>Delete goal</button>
      </div>
    </div>
  );
}

function AddGoal({ horizon, goals, ventures, onAdd }: { horizon: Horizon; goals: Goal[]; ventures: V[]; onAdd: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [venture, setVenture] = useState("");
  const [parent, setParent] = useState("");
  // A shorter goal can feed a longer one.
  const longer = goals.filter((g) => HORIZONS.indexOf(horizonOf(g)) < HORIZONS.indexOf(horizon));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (await onAdd({ name: name.trim(), horizon, ...(venture ? { venture } : {}), ...(parent ? { parent } : {}) })) { setName(""); setParent(""); }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border border-dashed p-3" style={{ borderColor: "var(--line)" }} aria-label={`Add a ${HORIZON_LABEL[horizon].toLowerCase()} goal`}>
      <input className="input h-9" placeholder={horizon === "long" ? "A long-term goal, e.g. where this is in 3 years" : horizon === "mid" ? "A goal for this quarter" : "A goal for the next two weeks"} aria-label="New goal" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
      <div className="flex gap-2">
        <select className="input h-9 flex-1" aria-label="Venture" value={venture} onChange={(e) => setVenture(e.target.value)}><option value="">No venture</option>{ventures.map((v) => <option key={v.id} value={v.id}>{v.short}</option>)}</select>
        {longer.length > 0 && <select className="input h-9 flex-1" aria-label="Feeds" value={parent} onChange={(e) => setParent(e.target.value)}><option value="">Feeds nothing</option>{longer.map((g) => <option key={g.id} value={g.id}>Feeds: {g.name}</option>)}</select>}
        <button className="btn btn-sm btn-primary h-9 flex-none" disabled={!name.trim()}>Add</button>
      </div>
    </form>
  );
}
