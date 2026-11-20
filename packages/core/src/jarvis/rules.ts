import type { Approval } from "../events.js";
import { PERSONAL_CALENDARS } from "../connectors/google.js";
import { BATCH_ACTION, batchSteps } from "./batch.js";

/** Actions that reach another person. */
const OUTBOUND_ACTIONS = new Set(["gmail.send", "x.post", "x.reply", "x.dm", "ghl.message"]);

/**
 * Actions that move money, trade, change a strategy, ship code or update HQ: no rule ever approves them on Phil's
 * behalf, whatever "kind" the agent wrote on the card (the agent chooses the kind; the action is what runs).
 */
const NEVER_AUTO = /^(trade\.|strategy\.|robinhood\.|hyperliquid\.|payment\.|invoice\.|transfer\.|wallet\.|order\.|eagleview\.order$|lp\.|github\.access$|code\.ship$|hq\.update$)/;
export function alwaysWaits(a: Pick<Approval, "kind" | "payload">): boolean {
  const action = (a.payload as { action?: unknown } | undefined)?.action;
  if (a.kind === "money" || a.kind === "strategy") return true;
  // A batch waits if any one of its steps would (or if it has none HQ can read).
  if (action === BATCH_ACTION) { const steps = batchSteps(a.payload); return !steps || steps.some((s) => alwaysWaits({ kind: a.kind, payload: s })); }
  return typeof action === "string" && NEVER_AUTO.test(action);
}

/** Work that stays inside Phil's own tools and HQ: the only actions the "only outbound waits" rule lets through. */
const INTERNAL_ACTIONS = /^(gmail\.(archive|label)|spotify\.playlist\.(create|add)|goals\.(update|benchmarks)|today\.set|watchlist\.add|memory\.replace|record\.(create|update|upsert)|ghl\.(note|contact\.create|deal\.(create|move)))$/;

/**
 * Work an agent may do on its own because HQ can put it back: Phil gets an Undo button instead of a card. Each one has
 * an undo in Jarvis.undoAuto. Not here on purpose: anything outbound, money, trades and code (alwaysWaits), trashing
 * mail, calendar changes (guests the card doesn't show), GoHighLevel writes (Phil's rule), setting the goals
 * themselves (Phil's call with Adam), and a scout's own stock idea for the watchlist (Phil picks what he watches).
 */
export const REVERSIBLE_ACTIONS = /^(memory\.replace|goals\.(update|benchmarks)|today\.set|gmail\.(archive|label))$/;
export function isReversible(a: Pick<Approval, "kind" | "payload">): boolean {
  const action = (a.payload as { action?: unknown } | undefined)?.action;
  return typeof action === "string" && REVERSIBLE_ACTIONS.test(action) && !alwaysWaits(a) && !isOutbound(a);
}

/**
 * Does this approval reach anyone besides Phil, or touch something only Phil should change? An allow-list: anything
 * not known to be internal counts as outbound, so it waits. Calendar cards count as internal only for a new event with
 * no guests on one of Phil's personal calendars, named explicitly; changes to existing events (whose guests the card
 * doesn't show) and anything on a business calendar wait. Monica's direct tools cover the safe personal changes.
 */
export function isOutbound(a: Pick<Approval, "kind" | "payload">): boolean {
  const p = (a.payload ?? {}) as { action?: unknown; attendees?: unknown; guests?: unknown; public?: unknown; account?: unknown };
  if (a.kind === "send" || a.kind === "post") return true;
  if (p.public === true) return true;
  if (typeof p.action === "string" && OUTBOUND_ACTIONS.has(p.action)) return true;
  if (Array.isArray(p.attendees) && p.attendees.length) return true;
  if (Array.isArray(p.guests) && p.guests.length) return true;
  // No action: approving only records Phil's decision, nothing runs.
  if (typeof p.action !== "string") return false;
  // A batch reaches out if any step does; one HQ can't read counts as outbound.
  if (p.action === BATCH_ACTION) { const steps = batchSteps(a.payload); return !steps || steps.some((s) => isOutbound({ kind: a.kind, payload: s })); }
  if (p.action === "calendar.create") return !(typeof p.account === "string" && PERSONAL_CALENDARS.includes(p.account.toLowerCase()));
  return !INTERNAL_ACTIONS.test(p.action);
}
