import type { ActivityEntry } from "./types";

/**
 * Worth reading: hand-offs, approvals and decisions, errors, memory, schedule runs that produced
 * something, system notes. Not the per-run lines ("Stella ran on claude-opus in 2.1s"), which the
 * Activity page shows only when asked.
 */
export const meaningful = (e: ActivityEntry) => e.kind !== "run";
