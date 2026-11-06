import { z } from "zod";
import type { Store } from "../store/types.js";
import { AGENTS, getAgent } from "../registry/index.js";
import { VENTURE_DASH } from "../ventures/dashboards.js";
import { usageSummary } from "../usage/caps.js";

/**
 * Tools agents can call. Provider-neutral: the Claude provider exposes them as an in-process MCP server
 * through the Agent SDK; prompt-only providers (Grok CLI) get a text summary instead.
 * Read-only in this phase. Anything that changes the world goes through the approval queue.
 */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<string>;
}

export interface ToolContext {
  store: Store;
  agentId: string;
}

/** Keeps each tool's argument types while storing them in one list. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function buildTools(): ToolDef[] {
  const tools: ToolDef[] = [
    defineTool({
      name: "memory_search",
      description: "Search what the web knows about Phil, his ventures and contacts. Returns matching memory bullets.",
      schema: { query: z.string().describe("words to look for"), scope: z.string().optional().describe("phil | venture:<id> | agent:<id> | contact:<name>") },
      async handler({ query, scope }, { store }) {
        const q = query.toLowerCase();
        const items = (await store.memory.list(scope)).filter((m) => `${m.key} ${m.value}`.toLowerCase().includes(q)).slice(0, 25);
        return items.length ? items.map((m) => `[${m.scope}] ${m.key}: ${m.value}`).join("\n") : "Nothing on file for that.";
      },
    }),
    defineTool({
      name: "web_status",
      description: "Who in the agent web is working, waiting on Phil, paused or in error right now, and what is waiting for approval.",
      schema: {},
      async handler(_args, { store }) {
        const states = await store.agentState.all();
        const pending = await store.approvals.list("pending");
        const lines = states.filter((s) => s.status !== "idle" || s.paused).map((s) => `${getAgent(s.id)?.name ?? s.id}: ${s.paused ? "paused" : s.status}${s.detail ? ` (${s.detail})` : ""}`);
        return `${lines.length ? lines.join("\n") : "Everyone idle."}\n${pending.length} approval(s) waiting${pending.length ? ": " + pending.map((p) => p.title).join("; ") : ""}.`;
      },
    }),
    defineTool({
      name: "goals_list",
      description: "Phil's goals as they stand: id, name, percent done, deadline, and which one is primary.",
      schema: {},
      async handler(_args, { store }) {
        const goals = await store.settings.get<{ id: string; name: string; pct: number; deadline?: string; primary: boolean; updatedAt: string }[] | null>("goals", null);
        if (!goals?.length) return "No goals set yet.";
        return goals.map((g) => `[${g.id}] ${g.primary ? "PRIMARY " : ""}${g.name} · ${g.pct}% done${g.deadline ? ` · due ${g.deadline}` : ""} · updated ${g.updatedAt.slice(0, 10)}`).join("\n");
      },
    }),
    defineTool({
      name: "web_health",
      description: "How the web did over the last N days (default 7): runs, errors and blocked runs per agent, the slowest agents, rejected and stale approvals, plan usage, and open items waiting on Phil. Use it for reviews and improvement proposals.",
      schema: { days: z.number().int().min(1).max(30).optional() },
      async handler({ days }, { store }) {
        const since = Date.now() - (days ?? 7) * 86_400_000;
        const rows = (await store.activity.list({ limit: 5000 })).filter((r) => Date.parse(r.at) >= since);
        const per = new Map<string, { runs: number; secs: number[]; errors: string[]; blocked: string[] }>();
        const get = (id: string) => per.get(id) ?? (per.set(id, { runs: 0, secs: [], errors: [], blocked: [] }), per.get(id)!);
        for (const r of rows) {
          const a = get(r.agentId);
          if (r.kind === "run") { a.runs++; const m = r.summary.match(/ in ([\d.]+)s$/); if (m) a.secs.push(Number(m[1])); }
          else if (r.kind === "error") a.errors.push(r.summary.slice(0, 160));
          else if (r.kind === "system" && / did not run: /.test(r.summary)) a.blocked.push(r.summary.replace(/^.*? did not run: /, "").slice(0, 120));
        }
        const name = (id: string) => getAgent(id)?.name ?? id;
        const avg = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
        const lines: string[] = [`Last ${days ?? 7} days.`];
        const active = [...per.entries()].filter(([, v]) => v.runs || v.errors.length || v.blocked.length).sort((x, y) => y[1].runs - x[1].runs);
        lines.push(`Runs by agent: ${active.map(([id, v]) => `${name(id)} ${v.runs}`).join(", ") || "none"}.`);
        const slow = active.filter(([, v]) => v.secs.length).map(([id, v]) => [id, avg(v.secs)] as const).sort((x, y) => y[1] - x[1]).slice(0, 5);
        if (slow.length) lines.push(`Slowest (average): ${slow.map(([id, s]) => `${name(id)} ${s.toFixed(0)}s`).join(", ")}.`);
        const errs = active.filter(([, v]) => v.errors.length);
        lines.push(errs.length ? `Errors:\n${errs.map(([id, v]) => `- ${name(id)} (${v.errors.length}): ${v.errors[v.errors.length - 1]}`).join("\n")}` : "Errors: none.");
        const blocked = active.filter(([, v]) => v.blocked.length);
        if (blocked.length) lines.push(`Didn't run:\n${blocked.map(([id, v]) => `- ${name(id)} (${v.blocked.length}): ${v.blocked[v.blocked.length - 1]}`).join("\n")}`);
        const appr = await store.approvals.list();
        const decided = appr.filter((a) => a.decidedAt && Date.parse(a.decidedAt) >= since);
        const rejected = decided.filter((a) => a.status === "rejected");
        const stale = appr.filter((a) => a.status === "pending" && Date.now() - Date.parse(a.at) > 3 * 86_400_000);
        lines.push(`Approvals decided: ${decided.length}, rejected ${rejected.length}${rejected.length ? ` (${[...new Set(rejected.map((a) => name(a.agentId)))].join(", ")})` : ""}; waiting over 3 days: ${stale.length}${stale.length ? ` (${stale.map((a) => a.title).slice(0, 5).join("; ")})` : ""}.`);
        const usage = await usageSummary(store);
        lines.push(`Plan usage this window: ${usage.plans.filter((p) => p.runs).map((p) => `${p.label} ${(p.used * 100).toFixed(0)}% (${p.runs} runs)`).join(", ") || "nothing used"}.`);
        return lines.join("\n");
      },
    }),
    defineTool({
      name: "chat_recent",
      description: "What Phil himself said to Jarvis over the last N days (newest first), optionally only lines containing a word. Use it to pick up what he's been talking about, such as stocks he mentioned.",
      schema: { days: z.number().int().min(1).max(30).optional(), query: z.string().max(60).optional() },
      async handler({ days, query }, { store }) {
        const since = Date.now() - (days ?? 7) * 86_400_000;
        const q = query?.toLowerCase();
        const rows = (await store.chat.list(1000)).filter((m) => m.role === "phil" && Date.parse(m.at) >= since && (!q || m.text.toLowerCase().includes(q))).reverse().slice(0, 80);
        return rows.length ? rows.map((m) => `${m.at.slice(0, 16)} ${m.text.slice(0, 400)}`).join("\n") : "Nothing from Phil in that window.";
      },
    }),
    defineTool({
      name: "activity_recent",
      description: "Recent activity log entries, optionally for one agent. Use it to see what already happened before doing it again.",
      schema: { agent: z.string().optional().describe("agent id"), limit: z.number().int().min(1).max(50).optional() },
      async handler({ agent, limit }, { store }) {
        const rows = await store.activity.list({ agentId: agent, limit: limit ?? 15 });
        return rows.length ? rows.map((r) => `${r.at.slice(0, 16)} ${r.summary}`).join("\n") : "Nothing logged yet.";
      },
    }),
    defineTool({
      name: "venture_board",
      description: "A venture's dashboard: latest metrics and tracker records (leads, jobs, holdings, strategies, posts...). Read it before adding or updating anything.",
      schema: { venture: z.string().describe("jdpm | proedge | range | philneeds | acres | crypto | money | lab | personal | command"), kind: z.string().optional().describe("one record kind only") },
      async handler({ venture, kind }, { store }) {
        const d = VENTURE_DASH[venture as keyof typeof VENTURE_DASH];
        if (!d) return "No such venture.";
        const latest = await store.metrics.latest(venture);
        const lines = [`Metrics: ${d.metrics.map((m) => `${m.key}=${latest.find((l) => l.key === m.key)?.value ?? "—"}`).join(", ") || "none"}`];
        for (const k of d.records.filter((r) => !kind || r.kind === kind)) {
          const items = await store.records.list(venture, k.kind);
          lines.push(`${k.label} (${items.length}):` + (items.length ? "\n" + items.slice(0, 40).map((i) => `  [${i.id}] ${i.title} · ${i.status}${Object.keys(i.fields).length ? " · " + JSON.stringify(i.fields) : ""}`).join("\n") : " none"));
        }
        return lines.join("\n");
      },
    }),
    defineTool({
      name: "roster",
      description: "Look up an agent in the web: job, team, who they report to, which venture.",
      schema: { name: z.string() },
      async handler({ name }) {
        const q = name.toLowerCase();
        const hits = AGENTS.filter((a) => a.id.includes(q) || a.name.toLowerCase().includes(q)).slice(0, 5);
        return hits.length ? hits.map((a) => `${a.name} (@${a.id}) — ${a.short}. ${a.desc} Venture: ${a.venture}. Reports to: ${[a.parent ?? "Phil", ...(a.alsoReportsTo ?? [])].join(", ")}.`).join("\n") : "No such agent.";
      },
    }),
  ];
  return tools;
}

export const TOOLS = buildTools();
export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function toolsText(tools: ToolDef[]): string {
  return tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
}
