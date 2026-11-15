"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AutoDone } from "@jarvis/core";
import { useLive } from "@/lib/live";
import { api, post, fmtTime } from "@/lib/api";

type Item = Omit<AutoDone, "snapshot">;

/** What agents did on their own (and could, because HQ can put it back), with one Undo button each. */
export function useAutoDone() {
  const { onEvent } = useLive();
  const [data, setData] = useState<{ on: boolean; items: Item[] } | null>(null);
  const load = useCallback(() => api<{ on: boolean; items: Item[] }>("/api/autodone").then(setData).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onEvent((e) => { if (e.type === "autodone") void load(); }), [onEvent, load]);
  return { data, load };
}

const ACTION: Record<string, string> = { "memory.replace": "Memory", "goals.update": "Goals", "goals.benchmarks": "Goals", "today.set": "Today", "gmail.archive": "Mail", "gmail.label": "Mail" };

export function DonePanel() {
  const { state } = useLive();
  const { data, load } = useAutoDone();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const name = (id: string) => state?.agents.find((a) => a.id === id)?.name ?? id;
  const undo = async (it: Item) => {
    setBusy(it.id);
    const r = await post<{ ok: boolean; result: string }>(`/api/autodone/${it.id}/undo`).catch((e) => ({ ok: false, result: (e as Error).message }));
    setMsg((m) => ({ ...m, [it.id]: r.result }));
    setBusy(null); await load();
  };
  if (!data) return <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Loading…</p>;
  return (
    <section id="done" className="flex flex-col gap-3" aria-label="Done for you">
      <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>
        {data.on
          ? "Work HQ can put back is done without asking: Oscar tidying memory, mail filed or labelled, goals ticked, today's three. Each has Undo. Anything that reaches a person, spends money, trashes mail or changes code still waits for you."
          : <>Agents doing reversible work on their own is off, so all of it waits under Approve. <Link href="/settings#autonomy">Turn it on in Settings</Link>.</>}
      </p>
      {data.items.length === 0 && <p className="m-0 text-[13px]" style={{ color: "var(--muted)" }}>Nothing done on its own yet.</p>}
      <ul className="m-0 p-0 list-none flex flex-col">
        {data.items.map((it) => (
          <li key={it.id} className="vitem" style={{ gridTemplateColumns: "minmax(0,1fr) auto auto", opacity: it.undone ? 0.55 : 1 }}>
            <div className="vitem-main" style={{ cursor: "default" }}>
              <b>{it.title}</b>
              <span>{name(it.agentId)} · {ACTION[it.action] ?? it.action} · {msg[it.id] ?? (it.undone ? `Undone: ${it.undone.result}` : it.outcome)}</span>
            </div>
            <span className="vitem-when">{fmtTime(it.at)}</span>
            {it.undone ? <span className="text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--dim)" }}>Undone</span>
              : <button className="btn btn-sm" disabled={busy === it.id} onClick={() => void undo(it)}>Undo</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
