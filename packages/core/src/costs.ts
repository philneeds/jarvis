import { z } from "zod";
import type { Store, UsageRecord } from "./store/types.js";
import { defineTool, type ToolDef } from "./tools/index.js";

/**
 * What it costs to keep Jarvis running, per month, in one place (Munger's). Two kinds of cost:
 *  - Fixed: the plans and bills HQ can't see (the Claude plan, SuperGrok, the server, anything else Phil pays for it).
 *    Phil tells Munger once; they are kept as lines in settings["hq.costs"] and changed through a costs.set card.
 *  - Metered: what HQ itself logs as it works. xAI credits (X search, images, Grok through the API) are logged from
 *    xAI's own usage numbers. X's API (Lists, posts, DMs) is logged at HQ's estimate of X's pay-per-use prices, so the
 *    X developer console's balance is the true figure. Claude and Grok runs on a plan are counted at list price for
 *    information only: the plan covers them, so they are not added to the total.
 */
export interface CostLine { name: string; monthlyUsd: number | null; note?: string; updatedAt?: string }
export const COSTS_KEY = "hq.costs";
/** The bills Jarvis is known to run on; amounts are Phil's to give. */
export const EXPECTED_COSTS: CostLine[] = [
  { name: "Claude plan", monthlyUsd: null, note: "the Claude agents run on it" },
  { name: "SuperGrok plan", monthlyUsd: null, note: "the Grok agents run on it" },
  { name: "HQ server", monthlyUsd: null, note: "hosting for HQ and its database" },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function costLines(store: Store): Promise<CostLine[]> {
  const saved = await store.settings.get<CostLine[]>(COSTS_KEY, []);
  return [...saved, ...EXPECTED_COSTS.filter((e) => !saved.some((s) => norm(s.name) === norm(e.name)))];
}

/** Add or change fixed lines by name, and drop the ones named in `remove`. */
export async function setCostLines(store: Store, lines: { name?: unknown; monthlyUsd?: unknown; note?: unknown }[], remove: unknown[] = [], now = new Date()): Promise<CostLine[]> {
  let all = await store.settings.get<CostLine[]>(COSTS_KEY, []);
  const gone = new Set(remove.map((r) => norm(String(r))));
  all = all.filter((l) => !gone.has(norm(l.name)));
  for (const l of lines) {
    const name = String(l.name ?? "").trim().slice(0, 80);
    const amount = typeof l.monthlyUsd === "number" ? l.monthlyUsd : Number(String(l.monthlyUsd ?? "").replace(/[$,\s]/g, ""));
    if (!name) throw new Error("each line needs a name");
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000) throw new Error(`"${name}" needs monthlyUsd: what it costs per month in dollars`);
    const line: CostLine = { name, monthlyUsd: Math.round(amount * 100) / 100, note: l.note ? String(l.note).slice(0, 200) : undefined, updatedAt: now.toISOString() };
    const i = all.findIndex((x) => norm(x.name) === norm(name));
    if (i >= 0) all[i] = { ...line, name: all[i]!.name }; else all.push(line);
  }
  await store.settings.set(COSTS_KEY, all);
  return all;
}

const SERVICES: { plan: string; label: string; billed: boolean; note: string }[] = [
  { plan: "xai", label: "xAI credits (X search, images, Grok API)", billed: true, note: "pay per use, from xAI's own usage numbers" },
  { plan: "x", label: "X API (Lists, posts, DMs)", billed: true, note: "pay per use, HQ's estimate; the X developer console's balance is the true figure" },
  { plan: "claude", label: "Claude runs", billed: false, note: "at list price, for information" },
  { plan: "supergrok", label: "Grok runs on SuperGrok", billed: false, note: "at list price, for information" },
];

export interface CostReport {
  month: string; daysIn: number; daysElapsed: number;
  fixed: CostLine[]; fixedUsd: number; unknown: string[];
  metered: { plan: string; label: string; billed: boolean; note: string; monthUsd: number; lastMonthUsd: number; calls: number; topAgents: { agentId: string; usd: number }[] }[];
  meteredUsd: number; projectedMeteredUsd: number; lastMonthMeteredUsd: number;
  /** Fixed lines that are known plus this month's metered spend projected to the month's end. */
  projectedTotalUsd: number;
}

export async function costReport(store: Store, now = new Date()): Promise<CostReport> {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const rows = await store.usage.since(lastStart);
  const daysIn = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = Math.max(1, (now.getTime() - start.getTime()) / 86_400_000);
  // When Claude or Grok runs go through an API key, they are billed, not covered by a plan.
  const billedPlans = new Set(["xai", "x", ...(Number(process.env.CLAUDE_MONTHLY_USD ?? 0) > 0 || process.env.CLAUDE_MODE === "api" ? ["claude"] : [])]);
  const sum = (r: UsageRecord[]) => r.reduce((a, x) => a + x.costUsd, 0);
  const metered = SERVICES.map((s) => {
    const mine = rows.filter((r) => r.plan === s.plan);
    const month = mine.filter((r) => r.at >= start.toISOString());
    const per = new Map<string, number>();
    for (const r of month) per.set(r.agentId, (per.get(r.agentId) ?? 0) + r.costUsd);
    return { ...s, billed: billedPlans.has(s.plan), monthUsd: sum(month), lastMonthUsd: sum(mine.filter((r) => r.at < start.toISOString())), calls: month.length, topAgents: [...per.entries()].map(([agentId, v]) => ({ agentId, usd: v })).filter((a) => a.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 5) };
  });
  const fixed = await costLines(store);
  const fixedUsd = fixed.reduce((a, l) => a + (l.monthlyUsd ?? 0), 0);
  const meteredUsd = sum(metered.filter((m) => m.billed).map((m) => ({ costUsd: m.monthUsd }) as UsageRecord));
  const projectedMeteredUsd = (meteredUsd / daysElapsed) * daysIn;
  return {
    month: start.toLocaleString("en-US", { month: "long", year: "numeric" }), daysIn, daysElapsed: Math.floor(daysElapsed),
    fixed, fixedUsd, unknown: fixed.filter((l) => l.monthlyUsd === null).map((l) => l.name),
    metered, meteredUsd, projectedMeteredUsd, lastMonthMeteredUsd: sum(metered.filter((m) => m.billed).map((m) => ({ costUsd: m.lastMonthUsd }) as UsageRecord)),
    projectedTotalUsd: fixedUsd + projectedMeteredUsd,
  };
}

export function costReportText(r: CostReport): string {
  const lines = [
    `What Jarvis costs to run, ${r.month} (day ${Math.max(1, r.daysElapsed)} of ${r.daysIn}).`,
    `Fixed, per month: ${usd(r.fixedUsd)}${r.unknown.length ? ` so far; NOT YET KNOWN: ${r.unknown.join(", ")} (ask Phil what each costs, then file a costs.set card)` : ""}`,
    ...r.fixed.map((l) => `- ${l.name}: ${l.monthlyUsd === null ? "unknown" : usd(l.monthlyUsd)}${l.note ? ` (${l.note})` : ""}`),
    `Pay per use, this month so far: ${usd(r.meteredUsd)}; at this pace ${usd(r.projectedMeteredUsd)} by month end; last month ${usd(r.lastMonthMeteredUsd)}.`,
    ...r.metered.map((m) => `- ${m.label}: ${usd(m.monthUsd)} this month over ${m.calls} call${m.calls === 1 ? "" : "s"}, ${usd(m.lastMonthUsd)} last month${m.billed ? "" : " — covered by the plan, not added to the total"} (${m.note})${m.topAgents.length ? `; most: ${m.topAgents.map((a) => `${a.agentId} ${usd(a.usd)}`).join(", ")}` : ""}`),
    `Total at this pace: ${usd(r.projectedTotalUsd)} for the month${r.unknown.length ? `, plus the ${r.unknown.length} unknown line${r.unknown.length === 1 ? "" : "s"}` : ""}.`,
    `To add or change a fixed line: an approval block, kind record, payload {"action":"costs.set","lines":[{"name":"...","monthlyUsd":0,"note":"..."}],"remove":["<name>"]}.`,
  ];
  return lines.join("\n");
}

export const COST_TOOLS: ToolDef[] = [
  defineTool({
    name: "hq_costs",
    description: "What it costs to keep Jarvis running this month: the fixed plans and bills Phil pays (as he gave them), what HQ has spent pay-per-use at xAI and on X's API so far, last month's figure, the pace for this month, and which agents spend the most. Read only.",
    schema: {},
    handler: async (_a, { store }) => costReportText(await costReport(store)),
  }),
];
