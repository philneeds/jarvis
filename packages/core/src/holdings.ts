import type { Store } from "./store/types.js";

/**
 * The money team's shared holdings note (memory "live:holdings"): Kubera's overall picture, each Robinhood position,
 * and, since Nov 28 2026, the venues HQ can read directly. Phil's first real Kalshi read showed why: Kubera had
 * Kalshi at $611 (cash, from its own link) while the account held about $6,030, so every agent working from Kubera
 * alone had his net worth $5,400 low. A venue read straight from the source is the truth for that venue; where
 * Kubera's figure for it differs, the note says by how much, in dollars, so nobody has to work it out or guess.
 * Kubera's own net worth number is never rewritten here: the gap is stated beside it.
 */
export interface LiveVenue {
  name: string;
  /** How Kubera names its line(s) for this venue. */
  match: RegExp;
  /** The account in words, read now. */
  text: () => Promise<string | undefined>;
  /** Everything the account holds, in dollars, when it can be told. */
  total?: () => Promise<number | undefined>;
}
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const short = (e: unknown) => (e as Error).message.slice(0, 160);

/** What Kubera's latest snapshot has for a venue: the sum of its lines whose name matches, or undefined when none does. */
export async function kuberaFigure(store: Pick<Store, "settings">, match: RegExp): Promise<number | undefined> {
  const hist = await store.settings.get<{ day: string; items?: Record<string, number> }[]>("kubera.history", []);
  const items = Object.entries(hist[hist.length - 1]?.items ?? {}).filter(([name]) => match.test(name));
  return items.length ? items.reduce((t, [, v]) => t + v, 0) : undefined;
}

/** One venue's part of the note: what it holds now, and how Kubera's figure for it compares. */
export async function venueSection(store: Pick<Store, "settings">, v: LiveVenue): Promise<string | undefined> {
  let text: string | undefined;
  try { text = await v.text(); } catch (e) { return `${v.name} couldn't be read just now: ${short(e)}`; }
  if (!text) return undefined;
  const lines = [`${v.name}, read straight from ${v.name} just now (for this account these figures are the real ones):\n${text}`];
  const total = await v.total?.().catch(() => undefined);
  if (total !== undefined && Number.isFinite(total)) {
    const k = await kuberaFigure(store, v.match).catch(() => undefined);
    // Small differences are timing; a real gap is said in dollars.
    const real = (gap: number) => Math.abs(gap) > Math.max(50, Math.abs(total) * 0.05);
    if (k !== undefined && real(total - k)) lines.push(`Kubera has ${v.name} at ${usd(k)}; the account itself holds ${usd(total)}. So Kubera's net worth figure is about ${usd(Math.abs(total - k))} too ${total > k ? "low" : "high"} on this account alone (its link to ${v.name} lags or doesn't count open positions). Say so when you quote net worth.`);
    else if (k === undefined && total > 50) lines.push(`Kubera has no line named for ${v.name}: unless Phil tracks it there under another name, its net worth figure leaves out this ${usd(total)}.`);
  }
  return lines.join("\n");
}

export async function holdingsNote(store: Pick<Store, "settings">, src: { kubera?: () => Promise<string | undefined>; robinhood?: () => Promise<string | undefined>; venues?: LiveVenue[] }): Promise<string> {
  const parts = await Promise.all([
    src.kubera?.().catch((e) => `Kubera couldn't be read: ${short(e)}`),
    src.robinhood?.().catch((e) => `Robinhood couldn't be read: ${short(e)}`),
    ...(src.venues ?? []).map((v) => venueSection(store, v)),
  ]);
  return parts.filter(Boolean).join("\n\n");
}
