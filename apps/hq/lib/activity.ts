import type { ActivityEntry, State } from "./types";

/**
 * Worth reading: hand-offs, approvals and decisions, errors, memory, schedule runs that produced
 * something, system notes. Not the per-run lines ("Stella ran on claude-opus in 2.1s"), which the
 * Activity page shows only when asked.
 */
export const meaningful = (e: ActivityEntry) => e.kind !== "run";

// ---- Plain English for the feed --------------------------------------------------------------
// The server now writes memory lines as "Einstein saved an idea: Grok phone calls." (packages/core
// src/jarvis/readable.ts). Entries stored before that read "Einstein remembered [agent:einstein]
// idea:grok-phone-calls" or "Phil set [scope] key"; these rules (a copy of core's) rewrite them for display.

const TITLED = new Set(["idea", "plan", "goal", "decision", "question", "preference", "reminder", "task", "todo", "project", "fact", "rule", "lesson", "habit", "visual"]);

/** "grok-phone-calls" → "Grok phone calls". */
export function humanize(s: string): string {
  const t = s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_./]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return t ? t[0]!.toUpperCase() + t.slice(1) : s;
}

function memoryLine(who: string, scope: string, key: string, byAgentId: string, state: State | null): string {
  let thing = "a note", title: string | undefined = humanize(key);
  const i = key.indexOf(":");
  if (i > 0) {
    const kind = key.slice(0, i).trim().toLowerCase(), rest = key.slice(i + 1).trim();
    if (TITLED.has(kind) && rest) { thing = `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`; title = humanize(rest); }
    else { thing = `a note about ${humanize(kind).toLowerCase()}`; title = undefined; }
  }
  const j = scope.indexOf(":");
  const sk = j > 0 ? scope.slice(0, j) : scope, id = j > 0 ? scope.slice(j + 1).trim() : "";
  const whose = scope === "phil" ? " to Phil's profile"
    : !id ? ""
    : sk === "agent" ? (id === byAgentId ? "" : ` for ${state?.agents.find((a) => a.id === id)?.name ?? humanize(id)}`)
    : sk === "venture" ? ` for ${state?.ventures[id as keyof State["ventures"]]?.label ?? humanize(id)}`
    : sk === "contact" ? ` on ${humanize(id).replace(/\b\w/g, (c) => c.toUpperCase())}`
    : "";
  return `${who} saved ${thing}${whose}${title ? `: ${title}` : ""}.`;
}

const OLD_MEMORY = /^(.+?) (?:remembered|set) \[([^\]]+)\] (.+)$/;

/** The line to show for an entry: old raw memory lines rewritten to read like English, the rest as written. */
export function readable(e: ActivityEntry, state: State | null): string {
  if (e.kind === "memory") {
    const m = OLD_MEMORY.exec(e.summary);
    if (m) return memoryLine(m[1]!, m[2]!, m[3]!.trim(), e.agentId, state);
  }
  return e.summary;
}

/** Cut long text at a word, with an ellipsis, so a feed row stays two or three lines. */
export function clip(s: string, max = 140): string {
  return s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}
