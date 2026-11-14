"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { nowStrip, type NowLine } from "@jarvis/core/home";
import { useLive } from "@/lib/live";
import { api, timeAgo } from "@/lib/api";
import type { ActivityEntry } from "@/lib/types";

/**
 * The top of home: who is working on what, who is waiting on Phil, and the last three things that finished.
 * Built from the live feed; the finished runs are seeded once from the activity log (the live feed loads without
 * run lines) and then follow the websocket.
 */
export function Now() {
  const { state, pending, attention, activity } = useLive();
  const [seed, setSeed] = useState<ActivityEntry[]>([]);
  const [, tick] = useState(0);
  useEffect(() => { api<{ entries: ActivityEntry[] }>("/api/activity?limit=60").then((r) => setSeed(r.entries.filter((e) => e.kind === "run"))).catch(() => undefined); }, []);
  // "2m ago" stays honest without a refresh.
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);

  const strip = useMemo(() => {
    const ids = new Set(activity.map((e) => e.id));
    return nowStrip({ agents: state?.agents ?? [], pending, attention, activity: [...activity, ...seed.filter((e) => !ids.has(e.id))] });
  }, [state?.agents, pending, attention, activity, seed]);

  if (!state) return <section aria-label="Now" className="panel min-h-24 w-full" />;
  const color = (venture: string) => state.ventures[venture as keyof typeof state.ventures]?.color ?? "var(--accent)";
  const { working, waiting, finished } = strip;
  return (
    <section aria-label="Now" aria-live="polite" className="panel px-4 py-3 grid gap-4 md:grid-cols-3 w-full">
      <Col title={`Working now · ${working.length}`} tone="var(--st-working)" empty="Nobody is working right now." href="/web"
        rows={working.slice(0, 4).map((n) => <Row key={n.agentId} n={n} color={color} dot />)} />
      <Col title={`Waiting on you · ${waiting.length}`} tone={waiting.length ? "var(--st-needs)" : "var(--accent)"} empty="Nobody is waiting on you." href="/attention"
        rows={waiting.slice(0, 4).map((n) => <Row key={n.agentId} n={n} color={color} right={n.count ? `${n.count} items` : n.at ? timeAgo(n.at) : undefined} />)} />
      <Col title="Just finished" tone="var(--accent)" empty="Nothing has finished yet." href="/activity"
        rows={finished.map((n, i) => <Row key={`${n.agentId}-${i}`} n={n} color={color} right={n.at ? timeAgo(n.at) : undefined} />)} />
    </section>
  );
}

/** One agent, one line: name in the venture's colour, the line, and a time or count on the right. */
function Row({ n, right, dot, color }: { n: NowLine; right?: string; dot?: boolean; color: (venture: string) => string }) {
  return (
    <li className="flex items-baseline gap-2 text-[12px] leading-snug min-w-0">
      {dot ? <span className="working-dot flex-none self-center" style={{ background: color(n.venture) }} /> : null}
      <Link href={`/agents/${n.agentId}`} className="flex-none font-semibold" style={{ color: color(n.venture) }}>{n.name}</Link>
      <Link href={n.href} className="truncate min-w-0" style={{ color: "var(--ink-bright)" }} title={n.line}>{n.line}</Link>
      {right && <span className="ml-auto flex-none text-[11px] whitespace-nowrap" style={{ color: "var(--muted)" }}>{right}</span>}
    </li>
  );
}

function Col({ title, tone, empty, rows, href }: { title: string; tone: string; empty: string; rows: ReactNode[]; href: string }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <Link href={href} className="label" style={{ color: tone }}>{title}</Link>
      {rows.length ? <ul className="m-0 p-0 list-none flex flex-col gap-1.5">{rows}</ul> : <span className="text-[12px]" style={{ color: "var(--muted)" }}>{empty}</span>}
    </div>
  );
}
