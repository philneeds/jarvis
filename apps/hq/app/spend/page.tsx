"use client";

import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, put } from "@/lib/api";

/** What the server's cost report holds (see core/costs.ts). */
interface CostLine { name: string; monthlyUsd: number | null; note?: string }
interface Metered { plan: string; label: string; billed: boolean; note: string; monthUsd: number; lastMonthUsd: number; calls: number; topAgents: { agentId: string; usd: number }[] }
interface CostReport { month: string; daysIn: number; daysElapsed: number; fixed: CostLine[]; fixedUsd: number; unknown: string[]; metered: Metered[]; meteredUsd: number; projectedMeteredUsd: number; lastMonthMeteredUsd: number; projectedTotalUsd: number }

/**
 * Slice colors. A color belongs to the thing, not to its rank: the Claude plan is always blue, whatever it costs this
 * month. Checked against HQ's panel color for contrast and for color-blind separation; lines Phil adds take the next
 * free color, and anything past the last one folds into Other.
 */
const FIXED_COLOR: Record<string, string> = { "claude plan": "#338ced", "supergrok plan": "#e76624", "hq server": "#00a888" };
const METERED_COLOR: Record<string, string> = { xai: "#d28e05", x: "#e24d8b" };
const SPARE = ["#0aac23", "#9887ef"];
const OTHER = "#8FB4E8";
const SURFACE = "#0A235A";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface Slice { id: string; label: string; usd: number; color: string; kind: "fixed" | "pay per use" }

function slicesOf(r: CostReport): Slice[] {
  const pace = r.meteredUsd > 0 ? r.projectedMeteredUsd / r.meteredUsd : 1;
  const out: Slice[] = [];
  const spare = [...SPARE];
  let other = 0;
  for (const l of r.fixed) {
    if (!l.monthlyUsd) continue;
    const color = FIXED_COLOR[key(l.name)] ?? spare.shift();
    if (color) out.push({ id: `f:${l.name}`, label: l.name, usd: l.monthlyUsd, color, kind: "fixed" }); else other += l.monthlyUsd;
  }
  for (const m of r.metered) if (m.billed && m.monthUsd > 0) out.push({ id: `m:${m.plan}`, label: m.label, usd: m.monthUsd * pace, color: METERED_COLOR[m.plan] ?? OTHER, kind: "pay per use" });
  if (other > 0) out.push({ id: "other", label: "Other fixed lines", usd: other, color: OTHER, kind: "fixed" });
  return out;
}

/** A ring split by share, with a gap of the panel color between slices; the middle names the slice under the pointer. */
function Donut({ slices, total, active, onActive }: { slices: Slice[]; total: number; active: string | null; onActive: (id: string | null) => void }) {
  const R = 90, r = 56, C = 110;
  const pt = (rad: number, a: number) => [C + rad * Math.sin(a), C - rad * Math.cos(a)] as const;
  let a0 = 0;
  const paths = slices.map((s) => {
    const sweep = (s.usd / total) * Math.PI * 2;
    const a1 = a0 + Math.min(sweep, Math.PI * 2 - 0.0001);
    const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r, a1), [x3, y3] = pt(r, a0);
    const big = sweep > Math.PI ? 1 : 0;
    const d = `M${x0} ${y0} A${R} ${R} 0 ${big} 1 ${x1} ${y1} L${x2} ${y2} A${r} ${r} 0 ${big} 0 ${x3} ${y3} Z`;
    a0 += sweep;
    return { s, d };
  });
  const cur = slices.find((s) => s.id === active);
  return (
    <svg viewBox="0 0 220 220" className="w-full max-w-[280px] h-auto" role="img" aria-label={`Monthly running cost by line: ${slices.map((s) => `${s.label} ${usd(s.usd)}`).join(", ")}`}>
      {paths.map(({ s, d }) => (
        <path key={s.id} d={d} fill={s.color} stroke={SURFACE} strokeWidth={2} strokeLinejoin="round" opacity={active && active !== s.id ? 0.35 : 1} style={{ cursor: "pointer", transition: "opacity 120ms" }}
          tabIndex={0} aria-label={`${s.label}: ${usd(s.usd)}, ${Math.round((s.usd / total) * 100)}%`}
          onMouseEnter={() => onActive(s.id)} onMouseLeave={() => onActive(null)} onFocus={() => onActive(s.id)} onBlur={() => onActive(null)} onClick={() => onActive(active === s.id ? null : s.id)} />
      ))}
      <text x={C} y={C - 12} textAnchor="middle" fontSize="9" letterSpacing="1.4" fill="var(--muted)">{(cur ? cur.kind : "per month").toUpperCase()}</text>
      <text x={C} y={C + 10} textAnchor="middle" fontSize="20" fontWeight="600" fill="var(--ink-bright)">{usd(cur ? cur.usd : total)}</text>
      <text x={C} y={C + 26} textAnchor="middle" fontSize="9" fill="var(--muted)">{cur ? `${Math.round((cur.usd / total) * 100)}% · ${cur.label.length > 14 ? `${cur.label.slice(0, 13)}…` : cur.label}` : "at this pace"}</text>
    </svg>
  );
}

export default function SpendPage() {
  const { state } = useLive();
  const [r, setR] = useState<CostReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [added, setAdded] = useState({ name: "", usd: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<CostReport>("/api/costs").then(setR).catch((e) => setError((e as Error).message)); }, []);
  const name = (id: string) => state?.agents.find((a) => a.id === id)?.name ?? id;

  const slices = useMemo(() => (r ? slicesOf(r) : []), [r]);
  const total = slices.reduce((a, s) => a + s.usd, 0);
  // Who spends the pay-per-use money, across xAI and X together.
  const agents = useMemo(() => {
    const per = new Map<string, number>();
    for (const m of r?.metered ?? []) if (m.billed) for (const a of m.topAgents) per.set(a.agentId, (per.get(a.agentId) ?? 0) + a.usd);
    return [...per.entries()].map(([id, v]) => ({ id, usd: v })).sort((a, b) => b.usd - a.usd).slice(0, 8);
  }, [r]);
  const covered = (r?.metered ?? []).filter((m) => !m.billed && m.monthUsd > 0);

  const save = async (lines: { name: string; monthlyUsd: number }[], remove: string[] = []) => {
    setBusy(true); setError(null);
    try { setR(await put<CostReport>("/api/costs", { lines, remove })); setDraft({}); setAdded({ name: "", usd: "" }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const amount = (v: string) => Number(v.replace(/[$,\s]/g, ""));
  const valid = (v: string) => v.trim() !== "" && Number.isFinite(amount(v)) && amount(v) >= 0;

  return (
    <Shell>
      <div className="max-w-4xl w-full mx-auto p-4 flex flex-col gap-4">
        <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>SPEND</h1>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>What it costs to keep Jarvis running each month: the plans and bills you pay, plus what HQ spends pay-per-use as it works. Munger keeps this and reports on the 1st.</p>
        {error && <div className="card text-[12px]" role="alert" style={{ color: "var(--red)", borderColor: "var(--red)" }}>{error}</div>}
        {!r && !error && <div className="card text-center py-10" style={{ color: "var(--muted)" }}>Loading spend…</div>}
        {r && (
          <>
            <section className="grid grid-cols-2 sm:grid-cols-4 gap-3" aria-label="This month">
              {([["This month, at this pace", usd(r.projectedTotalUsd), r.month], ["Fixed plans and bills", usd(r.fixedUsd), "per month"], ["Pay per use so far", usd(r.meteredUsd), `day ${Math.max(1, r.daysElapsed)} of ${r.daysIn}`], ["Pay per use last month", usd(r.lastMonthMeteredUsd), "xAI and X API"]] as const).map(([label, value, sub]) => (
                <div key={label} className="card flex flex-col gap-1">
                  <span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{label}</span>
                  <span className="display text-2xl" style={{ color: "var(--ink-bright)" }}>{value}</span>
                  <span className="text-[11px]" style={{ color: "var(--dim)" }}>{sub}</span>
                </div>
              ))}
            </section>
            {r.unknown.length > 0 && <div className="card text-[12px]" style={{ borderColor: "var(--amber)" }}><span style={{ color: "var(--amber)" }}>Not in the total yet:</span> {r.unknown.join(", ")}. Put in what each costs per month below.</div>}

            <section className="card flex flex-col gap-3" aria-label="Where the money goes">
              <span className="label">Where the money goes</span>
              {slices.length === 0 ? <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Nothing to show yet. Fill in what your plans cost below, and pay-per-use spend appears here as agents work.</p> : (
                <div className="flex flex-col sm:flex-row items-center gap-5">
                  <Donut slices={slices} total={total} active={active} onActive={setActive} />
                  <table className="tbl flex-1 w-full">
                    <thead><tr><th>Line</th><th>Kind</th><th className="text-right">Per month</th><th className="text-right">Share</th></tr></thead>
                    <tbody>
                      {slices.map((s) => (
                        <tr key={s.id} onMouseEnter={() => setActive(s.id)} onMouseLeave={() => setActive(null)} style={{ background: active === s.id ? "rgba(60,130,255,0.18)" : undefined }}>
                          <td><span aria-hidden className="inline-block align-middle mr-2" style={{ width: 10, height: 10, borderRadius: 2, background: s.color }} />{s.label}</td>
                          <td style={{ color: "var(--muted)" }}>{s.kind}</td>
                          <td className="text-right">{usd(s.usd)}</td>
                          <td className="text-right">{Math.round((s.usd / total) * 100)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="m-0 text-[11px]" style={{ color: "var(--dim)" }}>Pay-per-use lines are this month&apos;s spend carried to month end at the current pace. The X API figure is HQ&apos;s estimate from X&apos;s prices; the X developer console&apos;s balance is the true number.</p>
            </section>

            {agents.length > 0 && (
              <section className="card flex flex-col gap-2" aria-label="Who spends the pay-per-use money">
                <span className="label">Who spends the pay-per-use money, this month</span>
                {agents.map((a) => (
                  <div key={a.id} className="grid items-center gap-2 text-[12px]" style={{ gridTemplateColumns: "minmax(70px, 110px) 1fr max-content" }} title={`${name(a.id)}: ${usd(a.usd)} this month`}>
                    <span className="truncate">{name(a.id)}</span>
                    <span className="block h-[10px]" style={{ background: "rgba(0,0,0,0.25)" }}><i className="block h-full" style={{ width: `${Math.max(2, (a.usd / agents[0]!.usd) * 100)}%`, background: "var(--accent)", borderRadius: "0 4px 4px 0" }} /></span>
                    <span>{usd(a.usd)}</span>
                  </div>
                ))}
              </section>
            )}

            <section className="card flex flex-col gap-3" aria-label="Fixed plans and bills">
              <span className="label">Fixed plans and bills</span>
              <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>HQ can&apos;t see these bills, so they are what you tell it. Change an amount and save; nothing is charged from here.</p>
              {r.fixed.map((l) => {
                const v = draft[l.name] ?? (l.monthlyUsd === null ? "" : String(l.monthlyUsd));
                const changed = draft[l.name] !== undefined && valid(v) && amount(v) !== l.monthlyUsd;
                return (
                  <div key={l.name} className="grid items-center gap-2" style={{ gridTemplateColumns: "1fr 110px max-content max-content" }}>
                    <span className="text-[13px]">{l.name}{l.note ? <span className="text-[11px]" style={{ color: "var(--dim)" }}> · {l.note}</span> : null}</span>
                    <input className="input" inputMode="decimal" placeholder="$ / month" aria-label={`${l.name}, dollars per month`} value={v} onChange={(e) => setDraft({ ...draft, [l.name]: e.target.value })} />
                    <button className="btn btn-sm" disabled={busy || !changed} onClick={() => save([{ name: l.name, monthlyUsd: amount(v) }])}>Save</button>
                    <button className="btn btn-sm" disabled={busy || l.monthlyUsd === null} aria-label={`Remove ${l.name}`} onClick={() => save([], [l.name])}>×</button>
                  </div>
                );
              })}
              <div className="grid items-center gap-2 border-t pt-3" style={{ gridTemplateColumns: "1fr 110px max-content", borderColor: "var(--line)" }}>
                <input className="input" placeholder="Another bill (Kubera, a domain…)" aria-label="Name of another bill" value={added.name} onChange={(e) => setAdded({ ...added, name: e.target.value })} />
                <input className="input" inputMode="decimal" placeholder="$ / month" aria-label="Its cost in dollars per month" value={added.usd} onChange={(e) => setAdded({ ...added, usd: e.target.value })} />
                <button className="btn btn-sm" disabled={busy || !added.name.trim() || !valid(added.usd)} onClick={() => save([{ name: added.name.trim(), monthlyUsd: amount(added.usd) }])}>Add</button>
              </div>
            </section>

            {covered.length > 0 && (
              <section className="card flex flex-col gap-1 text-[12px]" aria-label="Covered by your plans">
                <span className="label">Covered by your plans</span>
                <p className="m-0" style={{ color: "var(--muted)" }}>Work the plans already pay for, at list price, for a sense of what they&apos;re worth. Not added to the total.</p>
                {covered.map((m) => <div key={m.plan} className="flex justify-between gap-3"><span>{m.label} · {m.calls.toLocaleString()} runs</span><span>{usd(m.monthUsd)}</span></div>)}
              </section>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
