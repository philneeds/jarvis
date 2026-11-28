import { AGENTS, type AgentDef } from "./registry/index.js";
import { CHARTERS } from "./registry/charters.js";

/**
 * What each agent of a phase still lacks before the switch is flipped: the connections its tools need. Shown on the
 * Build phase card, so Phil knows who starts thin.
 */
export type Connection = "Google" | "X" | "X search" | "Spotify" | "Kubera" | "Robinhood" | "GoHighLevel" | "EagleView" | "LeadPerfection" | "Discord" | "GitHub" | "Apple Health";
export const ALL_CONNECTIONS: Connection[] = ["Google", "GoHighLevel", "Kubera", "Robinhood", "Spotify", "Discord", "GitHub", "Apple Health", "EagleView", "LeadPerfection", "X", "X search"];
const NEEDS: [RegExp, Connection][] = [
  [/^(gmail_|calendar_|google_)/, "Google"], [/^(x_own_|x_mentions|x_dm_|x_list_)/, "X"], [/^x_search$/, "X search"], [/^spotify_/, "Spotify"], [/^kubera_/, "Kubera"],
  [/^robinhood_/, "Robinhood"], [/^ghl_/, "GoHighLevel"], [/^eagleview_/, "EagleView"], [/^lp_/, "LeadPerfection"], [/^discord_/, "Discord"], [/^github_/, "GitHub"], [/^health_/, "Apple Health"],
];
/**
 * Connections an agent works without. X search is xAI's paid API: without it agents still read any post or account they
 * are pointed at (x_recent_posts and post links are free), they just can't search X. EagleView is JD PM's roof
 * measurement service: without it Jake and Bill estimate from the site visit, as they did before. Missing one never
 * holds up setup.
 */
export const OPTIONAL_CONNECTIONS: Connection[] = ["X search", "EagleView"];
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
