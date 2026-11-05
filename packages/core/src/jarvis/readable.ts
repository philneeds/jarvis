import { getAgent } from "../registry/index.js";
import { VENTURES, type VentureId } from "../registry/ventures.js";

/**
 * Plain-English lines for the activity feed, so Phil reads "Einstein saved an idea: Grok phone calls."
 * instead of "Einstein remembered [agent:einstein] idea:grok-phone-calls". HQ keeps a copy of these rules
 * (apps/hq/lib/activity.ts) to rewrite entries stored before this existed; keep the two in step.
 */

/** Key prefixes that name a thing worth titling: "idea:grok-phone-calls" → "an idea: Grok phone calls". */
const TITLED = new Set(["idea", "plan", "goal", "decision", "question", "preference", "reminder", "task", "todo", "project", "fact", "rule", "lesson", "habit", "visual"]);

/** "grok-phone-calls" → "Grok phone calls"; "favouriteCoffee" → "Favourite coffee". */
export function humanize(s: string): string {
  const t = s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_./]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return t ? t[0]!.toUpperCase() + t.slice(1) : s;
}

const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");

/** What a memory key is: { thing: "an idea", title: "Grok phone calls" }, { thing: "a note about music" }, { thing: "a note", title: "Favourite coffee" }. */
export function describeMemoryKey(key: string): { thing: string; title?: string } {
  const i = key.indexOf(":");
  if (i > 0) {
    const kind = key.slice(0, i).trim().toLowerCase(), rest = key.slice(i + 1).trim();
    if (TITLED.has(kind) && rest) return { thing: `${article(kind)} ${kind}`, title: humanize(rest) };
    return { thing: `a note about ${humanize(kind).toLowerCase()}` };
  }
  return { thing: "a note", title: humanize(key) };
}

/** Whose memory it is, as a phrase to append; empty when it's the saving agent's own notes. */
export function describeMemoryScope(scope: string, byAgentId?: string): string {
  if (scope === "phil") return " to Phil's profile";
  const i = scope.indexOf(":");
  const kind = i > 0 ? scope.slice(0, i) : scope, id = i > 0 ? scope.slice(i + 1).trim() : "";
  if (!id) return "";
  if (kind === "agent") return id === byAgentId ? "" : ` for ${getAgent(id)?.name ?? humanize(id)}`;
  if (kind === "venture") return ` for ${VENTURES[id as VentureId]?.label ?? humanize(id)}`;
  if (kind === "contact") return ` on ${humanize(id).replace(/\b\w/g, (c) => c.toUpperCase())}`;
  return "";
}

/** The feed line for a saved memory: "Einstein saved an idea: Grok phone calls." / "Phil saved an idea for Einstein: Grok phone calls." */
export function memoryLine(who: string, scope: string, key: string, byAgentId?: string): string {
  const { thing, title } = describeMemoryKey(key);
  return `${who} saved ${thing}${describeMemoryScope(scope, byAgentId)}${title ? `: ${title}` : ""}.`;
}
