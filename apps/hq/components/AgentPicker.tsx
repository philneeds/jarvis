"use client";

import { pickerGroups, addressee } from "@jarvis/core/home";
import { useLive } from "@/lib/live";

const WORD: Record<string, string> = { working: "working", waiting: "needs you", idle: "idle", error: "error", paused: "paused" };
const DOT: Record<string, string> = { working: "●", waiting: "◆", error: "✕", paused: "‖", idle: "○" };

/**
 * Who the command line goes to. Jarvis by default; leads first, then the rest of the team, each with their status.
 * Only agents that are live and ran in the last seven days; everyone else is in the Agent Web.
 * Picking one puts "@id " at the start of the line (or takes it off for Jarvis).
 */
export function AgentPicker({ text, onPick }: { text: string; onPick: (agentId: string) => void }) {
  const { state } = useLive();
  const groups = pickerGroups(state?.agents ?? []);
  const to = addressee(text);
  const known = to === "jarvis" || groups.some((g) => g.agents.some((a) => a.id === to));
  const label = (a: { name: string; status: string; short?: string }) => `${DOT[a.status] ?? "○"} ${a.name} · ${WORD[a.status] ?? a.status}${a.short ? ` — ${a.short}` : ""}`;
  return (
    <select className="input h-11 w-32 sm:w-44 flex-none text-[12px]" aria-label="Who to talk to" title="Who this goes to: Jarvis, or an agent directly"
      value={known ? to : ""} onChange={(e) => onPick(e.target.value)}>
      {!known && <option value="" disabled>@{to}</option>}
      <option value="jarvis">◎ Jarvis · default</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.agents.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
