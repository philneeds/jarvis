"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLive } from "@/lib/live";

/** Everyone working on something right now: who, on what, for how long. Pulses in the venture's colour. */
export function Working({ compact = false }: { compact?: boolean }) {
  const { state } = useLive();
  const since = useRef<Record<string, number>>({});
  const [, tick] = useState(0);
  const working = (state?.agents ?? []).filter((a) => a.status === "working");
  // Remember when each one started, so the strip can show elapsed time; forget it when they finish.
  for (const a of working) since.current[a.id] ??= Date.now();
  for (const id of Object.keys(since.current)) if (!working.some((a) => a.id === id)) delete since.current[id];
  useEffect(() => { if (!working.length) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [working.length]);
  if (!working.length) return null;
  const color = (venture: string) => state?.ventures[venture as keyof NonNullable<typeof state>["ventures"]]?.color ?? "var(--accent)";
  const elapsed = (id: string) => { const s = Math.max(0, Math.round((Date.now() - (since.current[id] ?? Date.now())) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
  if (compact) {
    return (
      <Link href="/command" className="flex items-center gap-2 text-[11px] tracking-[0.14em] uppercase whitespace-nowrap" title={working.map((a) => `${a.name}: ${a.detail ?? ""}`).join("\n")} style={{ color: "var(--accent)" }}>
        <span className="working-dot" style={{ background: color(working[0]!.venture) }} />
        {working.length === 1 ? `${working[0]!.name} working` : `${working.length} working`}
      </Link>
    );
  }
  return (
    <section aria-label="Working now" aria-live="polite" className="w-full flex flex-col gap-1.5 text-left">
      <span className="label">{working.length === 1 ? "Working on it" : `${working.length} working on it`}</span>
      <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
        {working.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-[12px] min-w-0">
            <span className="working-dot flex-none" style={{ background: color(a.venture) }} />
            <Link href={`/agents/${a.id}`} className="flex-none" style={{ color: color(a.venture) }}>{a.name}</Link>
            <span className="truncate min-w-0" style={{ color: "var(--ink)" }} title={a.detail}>{a.detail || "on it"}</span>
            <span className="ml-auto flex-none text-[11px]" style={{ color: "var(--muted)" }}>{elapsed(a.id)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
