import { AGENTS, type AgentDef } from "./registry/index.js";
import { CHARTERS } from "./registry/charters.js";

/**
 * What each agent of a phase still lacks before the switch is flipped: the connections its tools need. Shown on the
 * Build phase card, so Phil knows who starts thin.
 */
export type Connection = "Google" | "X" | "Spotify" | "Kubera" | "Robinhood" | "GoHighLevel" | "Discord" | "GitHub" | "Apple Health";
const NEEDS: [RegExp, Connection][] = [
  [/^(gmail_|calendar_|google_)/, "Google"], [/^(x_own_|x_mentions|x_dm_)/, "X"], [/^spotify_/, "Spotify"], [/^kubera_/, "Kubera"],
  [/^robinhood_/, "Robinhood"], [/^ghl_/, "GoHighLevel"], [/^discord_/, "Discord"], [/^github_/, "GitHub"], [/^health_/, "Apple Health"],
];
/** The connections an agent's charter tools rely on. */
export function connectionsFor(agent: AgentDef): Connection[] {
  const out = new Set<Connection>();
  for (const t of CHARTERS[agent.id]?.tools ?? []) for (const [re, c] of NEEDS) if (re.test(t)) out.add(c);
  return [...out];
}
export interface Readiness { agentId: string; name: string; model: string; missing: Connection[] }
/** Every agent that goes live in `phase`, with the connections it still lacks given what's connected now. */
export function phaseReadiness(phase: number, connected: Set<Connection>): Readiness[] {
  return AGENTS.filter((a) => a.phase === phase).map((a) => ({ agentId: a.id, name: a.name, model: a.model, missing: connectionsFor(a).filter((c) => !connected.has(c)) }));
}
