import type { Approval } from "../events.js";

/**
 * One card, several connector actions (Phil, Nov 13: same-kind changes come as ONE card). The payload is
 * {"action":"batch","steps":[{"action":"ghl.contact.create",...},{"action":"ghl.note","contactId":"$step1.contactId",...}]}
 * ("actions" is read the same as "steps"). Steps run in order and the card reports each one; the first that fails stops
 * the card, and the report lists what went through and what never ran.
 */
export const BATCH_ACTION = "batch";
export const MAX_BATCH_STEPS = 25;

export type Step = Record<string, unknown> & { action: string };

/** The steps of a batch card, or undefined when the payload isn't one. */
export function batchSteps(payload: Record<string, unknown> | undefined): Step[] | undefined {
  if (!payload) return undefined;
  const list = Array.isArray(payload.steps) ? payload.steps : Array.isArray(payload.actions) ? payload.actions : undefined;
  if (!list) return undefined;
  if (payload.action !== BATCH_ACTION && typeof payload.action === "string") return undefined;
  const steps = list.filter((s): s is Step => !!s && typeof s === "object" && typeof (s as { action?: unknown }).action === "string");
  return steps.length ? steps : undefined;
}

/** Cards that carry a list of steps without saying "batch" (Stella's {"actions":[...]} of Nov 18) become batch cards. */
export function asBatch(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof payload.action === "string") return undefined;
  return batchSteps(payload) ? { ...payload, action: BATCH_ACTION } : undefined;
}

/** What a step made (a new contact's id, say), for the steps after it. Executors record it with setStepResult. */
const results = new WeakMap<object, Record<string, string>>();
export function setStepResult(a: object, out: Record<string, string | undefined>): void {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(out)) if (typeof v === "string" && v) clean[k] = v;
  results.set(a, { ...(results.get(a) ?? {}), ...clean });
}
export function stepResult(a: object): Record<string, string> { return results.get(a) ?? {}; }

const REF = /^\$step(\d+)\.([A-Za-z_][\w]*)$/;
/** "$step1.contactId" in a step means the contactId step 1 made. */
export function refOf(v: unknown): { step: number; field: string } | undefined {
  const m = typeof v === "string" ? v.trim().match(REF) : null;
  return m ? { step: Number(m[1]), field: m[2]! } : undefined;
}

/** A step with its references filled in from earlier steps' results; throws when one isn't there. */
export function resolveStep(step: Step, made: Record<string, string>[], index: number): Step {
  const out: Step = { ...step };
  for (const [k, v] of Object.entries(step)) {
    const r = refOf(v);
    if (!r) continue;
    if (r.step < 1 || r.step >= index + 1) throw new Error(`"${String(v)}" points at step ${r.step}, which doesn't come before this one`);
    const got = made[r.step - 1]?.[r.field];
    if (!got) throw new Error(`needs step ${r.step}'s ${r.field}, which didn't come through`);
    out[k] = got;
  }
  return out;
}

/** The card's plain "if you approve" line for one step, with references read as words. */
export function stepForDisplay(step: Step): Step {
  const out: Step = { ...step };
  for (const [k, v] of Object.entries(step)) { const r = refOf(v); if (r) out[k] = `the ${r.field === "contactId" ? "contact" : r.field} from step ${r.step}`; }
  return out;
}

/** The text a step's executor falls back on when its payload has none (never the whole card's body). */
export function stepBody(step: Step): string {
  for (const k of ["body", "message", "text"]) if (typeof step[k] === "string") return step[k] as string;
  return "";
}

const TEXT_KEYS = ["body", "message", "text"] as const;
/**
 * Phil's Edit on a batch card. Pasted JSON (a list of steps, or {"steps":[...]}) replaces the steps; plain text goes to
 * the one step that carries text. Anything else leaves the steps as they were.
 */
export function editBatch(payload: Record<string, unknown>, edited: string): Record<string, unknown> {
  const t = edited.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as unknown;
      const steps = batchSteps(Array.isArray(j) ? { action: BATCH_ACTION, steps: j } : (j as Record<string, unknown>));
      if (steps) return { ...payload, action: BATCH_ACTION, steps, actions: undefined };
    } catch { /* not JSON: plain text */ }
  }
  const steps = batchSteps(payload);
  if (!steps) return payload;
  const withText = steps.flatMap((s, i) => { const k = TEXT_KEYS.find((x) => typeof s[x] === "string"); return k ? [{ i, k }] : []; });
  if (withText.length !== 1) return payload;
  const { i, k } = withText[0]!;
  return { ...payload, steps: steps.map((s, j) => (j === i ? { ...s, [k]: edited } : s)), actions: undefined };
}

export function stepApproval(a: Approval, step: Step): Approval {
  return { ...a, payload: step, body: stepBody(step) };
}
