import type { Approval } from "../events.js";
import { PERSONAL_CALENDARS } from "../connectors/google.js";

/** Actions that reach another person. */
const OUTBOUND_ACTIONS = new Set(["gmail.send", "x.post", "x.reply", "x.dm", "ghl.message"]);

/**
 * Actions that move money, trade, change a strategy, ship code or update HQ: no rule ever approves them on Phil's
 * behalf, whatever "kind" the agent wrote on the card (the agent chooses the kind; the action is what runs).
 */
const NEVER_AUTO = /^(trade\.|strategy\.|robinhood\.|payment\.|invoice\.|transfer\.|wallet\.|order\.|code\.ship$|hq\.update$)/;
export function alwaysWaits(a: Pick<Approval, "kind" | "payload">): boolean {
  const action = (a.payload as { action?: unknown } | undefined)?.action;
  return a.kind === "money" || a.kind === "strategy" || (typeof action === "string" && NEVER_AUTO.test(action));
}

/** Work that stays inside Phil's own tools and HQ: the only actions the "only outbound waits" rule lets through. */
const INTERNAL_ACTIONS = /^(gmail\.(archive|label)|spotify\.playlist\.(create|add)|goals\.(update|benchmarks)|watchlist\.add|memory\.replace|record\.(create|update|upsert)|ghl\.(note|contact\.create|deal\.(create|move)))$/;

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
  if (p.action === "calendar.create") return !(typeof p.account === "string" && PERSONAL_CALENDARS.includes(p.account.toLowerCase()));
  return !INTERNAL_ACTIONS.test(p.action);
}
