"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useLive } from "@/lib/live";

const ST: Record<string, string> = { working: "var(--st-working)", waiting: "var(--st-needs)", idle: "var(--st-idle)", error: "var(--st-error)", paused: "var(--st-paused)" };
const WORD: Record<string, string> = { working: "working", waiting: "needs you", idle: "idle", error: "error", paused: "paused" };
/** Tallest tower, in px, inside the 104px plot (the rest is room for the run count). */
const TALL = 86;

/**
 * One tower per lead. Height is the size of the lead's team (it doesn't jump around during the day); the small
 * number on top is runs today by that team. Colour is the team's state; lit when anyone on it needs Phil or is in
 * error. Names sit under the towers in their venture's colour; hover or focus shows the full line below.
 */
export function Towers() {
  const { state } = useLive();
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const touch = useRef(false);
  const show = (id: string | null) => { activeRef.current = id; setActive(id); };
  if (!state) return <div className="towers-skeleton" />;

  const leads = state.agents.filter((a) => a.layer === 1);
  const team = (id: string) => state.agents.filter((a) => { let p = a.parent; while (p) { if (p === id) return true; p = state.agents.find((x) => x.id === p)?.parent; } return false; });
  const rows = leads.map((l) => {
    const crew = team(l.id);
    const runs = (l.runsToday ?? 0) + crew.reduce((n, c) => n + (c.runsToday ?? 0), 0);
    const needs = l.status === "waiting" || crew.some((c) => c.status === "waiting");
    const err = l.status === "error" || crew.some((c) => c.status === "error");
    const st = err ? "error" : needs ? "waiting" : l.status;
    return { l, crew, runs, st, lit: needs || err };
  });
  const biggest = Math.max(1, ...rows.map((r) => r.crew.length + 1));
  const total = rows.reduce((n, r) => n + r.runs, 0);
  const cur = rows.find((r) => r.l.id === active);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  return (
    <section aria-label={`Your ${leads.length} leads`} className="flex flex-col gap-2 w-full">
      <span className="label">Your {leads.length} leads</span>
      <div className="towers" onPointerLeave={(e) => { if (e.pointerType === "mouse") show(null); }}>
        {rows.map(({ l, crew, runs, st, lit }) => (
          <Link
            key={l.id}
            href={`/ventures/${l.venture}`}
            className={`tower-col ${active === l.id ? "on" : ""}`}
            style={{ "--c": ST[st] ?? ST.idle } as React.CSSProperties}
            aria-label={`${l.name}: ${plural(runs, "run")} today by a team of ${crew.length + 1}, ${WORD[st] ?? st}. Opens ${state.ventures[l.venture]?.label ?? l.venture}.`}
            onPointerDown={(e) => { touch.current = e.pointerType !== "mouse"; }}
            onPointerEnter={(e) => { if (e.pointerType === "mouse") show(l.id); }}
            onFocus={() => { if (!touch.current) show(l.id); }}
            onBlur={() => { if (activeRef.current === l.id) show(null); }}
            onClick={(e) => {
              // Touch: the first tap shows the name and count, a second tap on the same tower opens it.
              if (touch.current && activeRef.current !== l.id) { e.preventDefault(); show(l.id); }
            }}
          >
            <span className="tower-plot">
              <span className="tower-runs" aria-hidden="true">{runs || ""}</span>
              <i className={`tower ${lit ? "lit" : ""}`} style={{ height: Math.round(18 + ((crew.length + 1) / biggest) * (TALL - 18)) }} />
            </span>
            <span className="tower-name" style={{ color: state.ventures[l.venture]?.color }}>{l.name.split(" ").pop()?.toUpperCase()}</span>
          </Link>
        ))}
      </div>
      <p className="m-0 text-[12px] leading-snug min-h-[2.5em]" aria-live="polite" style={{ color: cur ? "var(--ink-bright)" : "var(--muted)" }}>
        {cur
          ? <><span style={{ color: "var(--ink-strong)", fontWeight: 600 }}>{cur.l.name}</span> · {plural(cur.runs, "run")} today · team of {cur.crew.length + 1} · <span style={{ color: cur.st === "idle" ? "var(--muted)" : ST[cur.st] }}>{WORD[cur.st] ?? cur.st}</span>{touch.current ? " · tap again to open" : ""}</>
          : `Height is team size; the number is runs today${total ? ` (${plural(total, "run")} in all)` : ""}. Hover or tap a tower for more.`}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tracking-[0.08em] uppercase">
        <span style={{ color: "var(--st-needs)" }}>■ needs you</span><span style={{ color: "var(--st-working)" }}>■ working</span><span style={{ color: "#8FA3C8" }}>■ idle</span><span style={{ color: "var(--st-error)" }}>■ error</span>
      </div>
    </section>
  );
}
