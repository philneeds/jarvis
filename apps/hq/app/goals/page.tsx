"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { useUndo } from "@/lib/undo";
import { api, post, put, fmtTime } from "@/lib/api";
import { HORIZONS, HORIZON_HINT, HORIZON_LABEL, LEVEL_NAME, horizonOf, useBase, type Horizon } from "@/lib/base";
import type { BenchmarkCheck, Goal } from "@jarvis/core";

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
  const [allTrophies, setAllTrophies] = useState(false);
  const [checking, setChecking] = useState(false);

  const ventures = state ? Object.values(state.ventures).filter((v) => v.id !== "root" && state.agents.some((a) => a.venture === v.id)) : [];
  const venture = (id?: string) => (id && state ? state.ventures[id as keyof typeof state.ventures] : undefined);
  const run = async (fn: () => Promise<{ goals: Goal[] }>) => { setErr(undefined); try { setGoals((await fn()).goals); return true; } catch (e) { setErr((e as Error).message); return false; } };
  const update = (g: Goal, patch: Record<string, unknown>) => run(() => put(`/api/goals/${g.id}`, patch));
  // Read every checked benchmark now, instead of waiting for the hourly check.
  const checkNow = async () => { setChecking(true); try { await run(() => post("/api/goals/check")); } finally { setChecking(false); } };
  const checked = goals.some((g) => g.benchmarks?.some((b) => b.check));
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
        <header className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="display m-0 text-3xl font-bold tracking-[0.06em]" style={{ color: "var(--ink-strong)" }}>Goals</h1>
            <p className="m-0 mt-1 text-[12px]" style={{ color: "var(--muted)" }}>Short-term goals feed long-term ones. David sets the benchmarks and ticks them on evidence; a benchmark with a rule against Kubera or a board figure ticks itself.</p>
          </div>
          {checked && <button className="btn btn-sm flex-none" disabled={checking} onClick={() => void checkNow()}>{checking ? "Checking…" : "Check now"}</button>}
          <Link href="/" className="btn btn-sm flex-none">Back to base ›</Link>
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
                {list.length === 0 && h === "long" && <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>No long-term goal yet. One or two per venture is plenty.</p>}
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
                            {[v && <span key="v" style={{ color: v.color }}>{v.short}</span>, g.deadline && `due ${g.deadline}`, parent && `feeds “${parent.name}”`, kids.length > 0 && `${kids.length} goal${kids.length === 1 ? "" : "s"} feeding it`, marks.length > 0 && `${marks.filter((b) => b.done).length} of ${marks.length} benchmarks`].filter(Boolean).flatMap((x, i) => (i ? [" · ", x] : [x]))}
                          </p>
                        </div>
                        <span className="text-[13px] flex-none" style={{ color: g.pct >= 100 ? "var(--green)" : "var(--ink-strong)" }}>{g.pct}%</span>
                        <button className="btn btn-sm flex-none" aria-expanded={editing === g.id} onClick={() => setEditing(editing === g.id ? null : g.id)}>{editing === g.id ? "Done" : "Edit"}</button>
                      </div>
                      <div className="bar"><i style={{ width: `${g.pct}%` }} /></div>
                      {stalled && <p className="m-0 text-[11px]" style={{ color: "var(--amber)" }}>Nothing is feeding this yet: no benchmarks and no shorter goal under it. Ask David for benchmarks, or add a mid-term goal that feeds it.</p>}
                      {marks.length > 0 && <Benchmarks marks={marks} onToggle={(b) => void update(g, { benchmarksDone: b.done ? { undone: [b.id] } : { done: [b.id] } })} onResume={(b) => void update(g, { benchmarkChecks: { [b.id]: b.check } })} />}
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
          <div className="flex flex-wrap items-baseline gap-3"><h2 className="label m-0 font-normal">Trophies · {trophies.length}</h2><span className="text-[11px]" style={{ color: "var(--muted)" }}>One per benchmark met, one more for a finished goal. They level up the venture.</span></div>
          {levels.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {levels.map(([id, lv]) => { const v = venture(id); return <span key={id} className="base-chip normal-case tracking-normal text-[12px]" style={{ borderColor: v?.color }}><b style={{ color: v?.color }}>{v?.short ?? id}</b>&nbsp;· level {lv.level} {LEVEL_NAME[lv.level]}{lv.next ? ` · ${lv.next - lv.hits} to go` : ""}</span>; })}
            </div>
          )}
          {trophies.length === 0 ? <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>None yet. The first benchmark you or David tick earns one.</p> : (
            <ul className="card m-0 p-0 list-none flex flex-col">
              {trophies.slice(0, allTrophies ? 60 : 8).map((t, i) => { const v = venture(t.venture); return (
                <li key={t.id} className={`flex items-center gap-3 px-3 py-2 text-[12px] ${i ? "border-t" : ""}`} style={{ borderColor: "var(--line)" }}>
                  <span aria-hidden="true" className="flex-none w-2.5 h-2.5 rotate-45" style={{ background: "var(--gold)", boxShadow: "0 0 6px var(--gold)" }} />
                  <span className="flex-1 min-w-0 truncate" style={{ color: "var(--ink-bright)" }} title={t.kind === "goal" ? "Goal finished" : `Toward “${t.goalName}”`}>{t.kind === "goal" ? `Finished: ${t.title}` : t.title}</span>
                  {v && <span className="flex-none text-[10px] tracking-[0.12em]" style={{ color: v.color }}>{v.short}</span>}
                  <span className="flex-none hidden sm:inline" style={{ color: "var(--muted)" }}>{fmtTime(t.at)}</span>
                </li>
              ); })}
              {trophies.length > 8 && <li className="border-t px-3 py-1.5" style={{ borderColor: "var(--line)" }}><button className="text-[11px] underline-offset-2 hover:underline" style={{ color: "var(--muted)" }} onClick={() => setAllTrophies(!allTrophies)}>{allTrophies ? "Show fewer" : `Show all ${trophies.length}`}</button></li>}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  );
}

type V = { id: string; short: string };
type Mark = NonNullable<Goal["benchmarks"]>[number];

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
/** The rule in a few words (the same wording the server logs). */
function describeCheck(c: BenchmarkCheck, ventures: V[]): string {
  const sym = c.op === ">=" ? "≥" : "≤", held = "days" in c && c.days ? ` for ${c.days} days` : "";
  if (c.kind === "kubera_networth") return `Kubera net worth ${sym} ${money(c.value)}${held}`;
  if (c.kind === "kubera_item") return `Kubera “${c.name}” ${sym} ${money(c.value)}`;
  return `${ventures.find((v) => v.id === c.venture)?.short ?? c.venture} board ${c.key} ${sym} ${c.value.toLocaleString("en-US")}${held}`;
}

/**
 * What HQ last read for a checked benchmark: the source, the figure and when, green when the rule holds, amber when
 * it doesn't, red when the source couldn't be read (the tick is then left as it was). Paused means Phil ticked or
 * unticked it by hand and HQ is keeping out until he resumes.
 */
function AutoLine({ b, onResume }: { b: Mark; onResume?: () => void }) {
  if (!b.check) return null;
  const a = b.auto;
  const color = b.paused ? "var(--muted)" : a?.error ? "var(--red)" : a?.met ? "var(--green)" : a ? "var(--amber)" : "var(--muted)";
  const text = b.paused ? `paused: you ${b.done ? "ticked" : "unticked"} this yourself, so HQ isn't checking it` : !a ? "HQ checks this; not read yet" : a.error ? `${a.source}: ${a.error}` : `${a.met ? "met" : "not met"} · ${a.source} · ${a.figure}`;
  return <span className="block pl-7 text-[11px] leading-snug" style={{ color }}>{text}{b.paused && onResume && <> · <button className="underline-offset-2 hover:underline" style={{ color: "var(--accent)" }} onClick={onResume}>resume</button></>}</span>;
}

/** Open benchmarks listed; finished ones folded under one line, so a goal that's moving doesn't grow longer. */
function Benchmarks({ marks, onToggle, onResume }: { marks: Mark[]; onToggle: (b: Mark) => void; onResume: (b: Mark) => void }) {
  const [open, setOpen] = useState(false);
  const todo = marks.filter((b) => !b.done), done = marks.filter((b) => b.done);
  const row = (b: Mark) => <li key={b.id}><button className="base-todo" data-done={b.done} aria-pressed={b.done} title={b.check ? "HQ ticks this itself; a click of yours pauses that" : undefined} onClick={() => onToggle(b)}><i aria-hidden="true" /><span className="text-[12px]">{b.text}{b.check && <span className="ml-1.5 text-[10px] tracking-[0.12em]" style={{ color: "var(--accent)" }}>AUTO</span>}</span></button><AutoLine b={b} onResume={() => onResume(b)} /></li>;
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1">
      {todo.map(row)}
      {done.length > 0 && <li><button className="text-[11px] py-0.5 underline-offset-2 hover:underline" style={{ color: "var(--green)" }} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {done.length} done</button></li>}
      {open && done.map(row)}
    </ul>
  );
}

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
      {(goal.benchmarks?.length ?? 0) > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer" style={{ color: "var(--muted)" }}>Auto-checks: tie a benchmark to a figure HQ reads (Kubera net worth, a Kubera account, a board number) and it ticks itself</summary>
          <ul className="m-0 mt-2 p-0 list-none flex flex-col gap-2">
            {goal.benchmarks!.map((b) => <li key={b.id}><CheckEditor mark={b} ventures={ventures} onSave={(c) => onUpdate({ benchmarkChecks: { [b.id]: c } })} /></li>)}
          </ul>
        </details>
      )}
      <div className="flex gap-2">
        {!goal.primary && <button className="btn btn-sm" onClick={() => void onUpdate({ primary: true })}>Make primary</button>}
        <button className="btn btn-sm btn-danger ml-auto" onClick={onDelete}>Delete goal</button>
      </div>
    </div>
  );
}

type Kind = BenchmarkCheck["kind"] | "";
const KIND_LABEL: Record<Exclude<Kind, "">, string> = { kubera_networth: "Kubera net worth", kubera_item: "A Kubera account", metric: "A board figure" };

/** The rule for one benchmark: which figure, ≥ or ≤ what, and for how many days it must hold. Saved on Save, cleared on Clear. */
function CheckEditor({ mark, ventures, onSave }: { mark: Mark; ventures: V[]; onSave: (c: BenchmarkCheck | null) => Promise<boolean> }) {
  const c = mark.check;
  const [kind, setKind] = useState<Kind>(c?.kind ?? "");
  const [op, setOp] = useState<">=" | "<=">(c?.op ?? ">=");
  const [value, setValue] = useState(c ? String(c.value) : "");
  const [days, setDays] = useState(c && "days" in c && c.days ? String(c.days) : "");
  const [name, setName] = useState(c?.kind === "kubera_item" ? c.name : "");
  const [venture, setVenture] = useState(c?.kind === "metric" ? c.venture : "money");
  const [key, setKey] = useState(c?.kind === "metric" ? c.key : "net_worth");
  const build = (): BenchmarkCheck | undefined => {
    const v = Number(value.replace(/[$,\s]/g, ""));
    if (!kind || !Number.isFinite(v)) return undefined;
    const d = days ? Number(days) : undefined;
    const window = d && Number.isFinite(d) && d >= 2 ? { days: Math.round(d) } : {};
    if (kind === "kubera_networth") return { kind, op, value: v, ...window };
    if (kind === "kubera_item") return name.trim() ? { kind, name: name.trim(), op, value: v } : undefined;
    return venture && key.trim() ? { kind, venture, key: key.trim(), op, value: v, ...window } : undefined;
  };
  const next = build();
  const same = JSON.stringify(next ?? null) === JSON.stringify(c ?? null);
  return (
    <div className="flex flex-col gap-1.5 border p-2" style={{ borderColor: "var(--line)" }}>
      <span className="truncate" style={{ color: "var(--ink-bright)" }}>{mark.text}{c && <span className="ml-2" style={{ color: "var(--muted)" }}>· now: {describeCheck(c, ventures)}</span>}</span>
      <div className="flex flex-wrap gap-2 items-center">
        <select className="input h-8 w-auto text-[12px]" aria-label={`Check for ${mark.text}`} value={kind} onChange={(e) => setKind(e.target.value as Kind)}><option value="">No auto-check</option>{(Object.keys(KIND_LABEL) as Exclude<Kind, "">[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
        {kind === "kubera_item" && <input className="input h-8 w-40 text-[12px]" placeholder="Account name, e.g. Robinhood" aria-label="Kubera account" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
        {kind === "metric" && <>
          <select className="input h-8 w-auto text-[12px]" aria-label="Venture" value={venture} onChange={(e) => setVenture(e.target.value)}>{ventures.map((v) => <option key={v.id} value={v.id}>{v.short}</option>)}</select>
          <input className="input h-8 w-36 text-[12px]" list={`keys-${mark.id}`} placeholder="metric key" aria-label="Metric key" value={key} maxLength={60} onChange={(e) => setKey(e.target.value)} />
          <datalist id={`keys-${mark.id}`}>{["net_worth", "cash", "portfolio_value", "monthly_cash_flow", "revenue_month", "leads_week", "mrr", "followers"].map((k) => <option key={k} value={k} />)}</datalist>
        </>}
        {kind && <>
          <select className="input h-8 w-auto text-[12px]" aria-label="At least or at most" value={op} onChange={(e) => setOp(e.target.value as ">=" | "<=")}><option value=">=">at least</option><option value="<=">at most</option></select>
          <input className="input h-8 w-28 text-[12px]" inputMode="decimal" placeholder={kind === "metric" ? "value" : "$"} aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} />
          {kind !== "kubera_item" && <label className="flex items-center gap-1" style={{ color: "var(--muted)" }}>held <input className="input h-8 w-14 text-[12px]" inputMode="numeric" placeholder="—" aria-label="Days it must hold" value={days} onChange={(e) => setDays(e.target.value)} /> days</label>}
        </>}
        <span className="ml-auto flex gap-2">
          {c && <button type="button" className="btn btn-sm h-8" onClick={() => { void onSave(null); setKind(""); }}>Clear</button>}
          <button type="button" className="btn btn-sm btn-primary h-8" disabled={!next || same} onClick={() => void onSave(next!)}>{mark.paused ? "Save & resume" : "Save"}</button>
        </span>
      </div>
    </div>
  );
}

function AddGoal({ horizon, goals, ventures, onAdd }: { horizon: Horizon; goals: Goal[]; ventures: V[]; onAdd: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [venture, setVenture] = useState("");
  const [parent, setParent] = useState("");
  const [open, setOpen] = useState(false);
  // A shorter goal can feed a longer one.
  const longer = goals.filter((g) => HORIZONS.indexOf(horizonOf(g)) < HORIZONS.indexOf(horizon));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (await onAdd({ name: name.trim(), horizon, ...(venture ? { venture } : {}), ...(parent ? { parent } : {}) })) { setName(""); setParent(""); setOpen(false); }
  };
  const label = horizon === "long" ? "Add a long-term goal" : horizon === "mid" ? "Add a goal for this quarter" : "Add a goal for the next two weeks";
  if (!open) return <button className="border border-dashed px-3 py-2 text-left text-[12px] hover:border-solid" style={{ borderColor: "var(--line)", color: "var(--muted)" }} onClick={() => setOpen(true)}>+ {label}</button>;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border border-dashed p-3" style={{ borderColor: "var(--line)" }} aria-label={`Add a ${HORIZON_LABEL[horizon].toLowerCase()} goal`}>
      <input autoFocus className="input h-9" onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setName(""); } }} placeholder={horizon === "long" ? "A long-term goal, e.g. where this is in 3 years" : horizon === "mid" ? "A goal for this quarter" : "A goal for the next two weeks"} aria-label="New goal" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
      <div className="flex gap-2">
        <select className="input h-9 flex-1 min-w-0" aria-label="Venture" value={venture} onChange={(e) => setVenture(e.target.value)}><option value="">No venture</option>{ventures.map((v) => <option key={v.id} value={v.id}>{v.short}</option>)}</select>
        {longer.length > 0 && <select className="input h-9 flex-1 min-w-0" aria-label="Feeds" value={parent} onChange={(e) => setParent(e.target.value)}><option value="">Feeds nothing</option>{longer.map((g) => <option key={g.id} value={g.id}>Feeds: {g.name}</option>)}</select>}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-sm h-9" onClick={() => { setOpen(false); setName(""); }}>Cancel</button>
        <button className="btn btn-sm btn-primary h-9" disabled={!name.trim()}>Add</button>
      </div>
    </form>
  );
}
