"use client";

import Link from "next/link";
import { useLive } from "@/lib/live";

const ST: Record<string, string> = { working: "var(--st-working)", waiting: "var(--st-needs)", idle: "var(--st-idle)", error: "var(--st-error)", paused: "var(--st-paused)" };

/** One tower per lead; lit when anyone on their team needs Phil or is in error. */
export function Towers() {
  const { state } = useLive();
  if (!state) return <div className="towers" />;
  const leads = state.agents.filter((a) => a.layer === 1);
  const team = (id: string) => state.agents.filter((a) => { let p = a.parent; while (p) { if (p === id) return true; p = state.agents.find((x) => x.id === p)?.parent; } return false; });
  return (
    <section aria-label="Your 12 leads" className="flex flex-col gap-2">
      <span className="label">Towers · your 12 leads · tap to enter ❭</span>
      <div className="towers">
        {leads.map((l) => {
          const crew = team(l.id);
          const needs = l.status === "waiting" || crew.some((c) => c.status === "waiting");
          const err = l.status === "error" || crew.some((c) => c.status === "error");
          const st = err ? "error" : needs ? "waiting" : l.status;
          const lit = needs || err;
          return (
            <Link key={l.id} href={`/ventures/${l.venture}`} className={`tower ${lit ? "lit" : ""}`} style={{ "--c": ST[st] ?? ST.idle, height: 54 + crew.length * 8 } as React.CSSProperties} aria-label={`${l.name}, team of ${crew.length}, ${st}`} title={`${l.name} · ${st}`}>
              <span>{l.name.split(" ").pop()?.toUpperCase()}</span>
            </Link>
          );
        })}
      </div>
      <div className="flex gap-3 text-[10px] tracking-[0.08em] uppercase">
        <span style={{ color: "var(--st-needs)" }}>■ needs you</span><span style={{ color: "var(--st-working)" }}>■ working</span><span style={{ color: "#7A8DB5" }}>■ idle</span><span style={{ color: "var(--st-error)" }}>■ error</span>
      </div>
    </section>
  );
}
