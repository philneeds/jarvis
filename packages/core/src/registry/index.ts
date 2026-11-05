import { AGENTS, type AgentDef } from "./agents.js";
import { VENTURES, VENTURE_IDS, type VentureId } from "./ventures.js";

import { CHARTERS } from "./charters.js";
export * from "./agents.js";
export * from "./ventures.js";
export * from "./charters.js";

export const AGENT_BY_ID: Record<string, AgentDef> = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

export function getAgent(id: string): AgentDef | undefined {
  return AGENT_BY_ID[id.toLowerCase()];
}

/** Resolve a name like "Charlie Munger", "munger" or "@stella" to an agent. */
export function findAgent(nameOrId: string): AgentDef | undefined {
  const q = nameOrId.replace(/^@/, "").trim().toLowerCase();
  if (!q) return undefined;
  return (
    AGENT_BY_ID[q] ??
    AGENTS.find((a) => a.name.toLowerCase() === q) ??
    AGENTS.find((a) => a.name.toLowerCase().replace(/[^a-z0-9]/g, "") === q.replace(/[^a-z0-9]/g, "")) ??
    AGENTS.find((a) => a.name.toLowerCase().split(" ").includes(q))
  );
}

export function children(id: string): AgentDef[] {
  return AGENTS.filter((a) => a.parent === id);
}

export function teamSize(id: string): number {
  let n = 0;
  const walk = (p: string) => children(p).forEach((c) => { n++; walk(c.id); });
  walk(id);
  return n;
}

/** The 12 leads that work directly with Jarvis (secondary main layer). */
export function leads(): AgentDef[] {
  return AGENTS.filter((a) => a.layer === 1);
}

export function worksWith(id: string): string[] {
  const out = new Set<string>();
  const me = AGENT_BY_ID[id];
  me?.links?.forEach((l) => out.add(l));
  AGENTS.forEach((a) => { if (a.links?.includes(id)) out.add(a.id); });
  return [...out];
}

export function ventureAgents(v: VentureId): { own: AgentDef[]; helping: AgentDef[] } {
  return {
    own: AGENTS.filter((a) => a.venture === v),
    helping: AGENTS.filter((a) => a.serves?.includes(v)),
  };
}

/** Lead agent per venture, for the towers on the home screen. */
export function ventureLeads(): { venture: VentureId; lead?: AgentDef }[] {
  return VENTURE_IDS.filter((v) => v !== "root").map((v) => ({ venture: v, lead: VENTURES[v].lead ? AGENT_BY_ID[VENTURES[v].lead!] : undefined }));
}

/** Compact roster text for Jarvis's system prompt. */
/** Every agent Jarvis can route to, by lead, with each one's job from its charter and every layer under it. */
export function rosterText(): string {
  const lines: string[] = [];
  const job = (a: AgentDef) => CHARTERS[a.id]?.job ?? a.short;
  const walk = (a: AgentDef, depth: number) => {
    for (const c of children(a.id)) { lines.push(`${"  ".repeat(depth)}- ${c.name} [@${c.id}]: ${job(c)}`); walk(c, depth + 1); }
  };
  for (const lead of leads()) {
    lines.push(`- ${lead.name} [@${lead.id}] — ${job(lead)} Venture: ${VENTURES[lead.venture].label}.`);
    walk(lead, 1);
  }
  return lines.join("\n");
}
