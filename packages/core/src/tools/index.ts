import { z } from "zod";
import type { Store } from "../store/types.js";
import { AGENTS, getAgent } from "../registry/index.js";

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
      name: "activity_recent",
      description: "Recent activity log entries, optionally for one agent. Use it to see what already happened before doing it again.",
      schema: { agent: z.string().optional().describe("agent id"), limit: z.number().int().min(1).max(50).optional() },
      async handler({ agent, limit }, { store }) {
        const rows = await store.activity.list({ agentId: agent, limit: limit ?? 15 });
        return rows.length ? rows.map((r) => `${r.at.slice(0, 16)} ${r.summary}`).join("\n") : "Nothing logged yet.";
      },
    }),
    defineTool({
      name: "roster",
      description: "Look up an agent in the web: job, team, who they report to, which venture.",
      schema: { name: z.string() },
      async handler({ name }) {
        const q = name.toLowerCase();
        const hits = AGENTS.filter((a) => a.id.includes(q) || a.name.toLowerCase().includes(q)).slice(0, 5);
        return hits.length ? hits.map((a) => `${a.name} (@${a.id}) — ${a.short}. ${a.desc} Venture: ${a.venture}. Reports to: ${a.parent ?? "Phil"}.`).join("\n") : "No such agent.";
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
