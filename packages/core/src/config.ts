import type { ApprovalKind } from "./events.js";
import type { ModelKey } from "./registry/agents.js";
import type { Store } from "./store/types.js";
import { CHARTERS } from "./registry/charters.js";

/** Phil's template for each agent (from the scope doc). Every field is optional; blanks fall back to the registry. */
export interface Persona {
  reportsTo?: string;
  job?: string;
  daily?: string;
  tools?: string;
  alone?: string;
  approval?: string;
  preferredAI?: string;
  good?: string;
}

export interface AgentSchedule {
  enabled: boolean;
  /** "daily@HH:MM" or "every:<minutes>" */
  when: string;
  task: string;
}

export interface ApprovalRules {
  /** Kinds this agent may do without Phil (low-risk record changes, drafts never need it anyway). */
  autoApprove: ApprovalKind[];
  /** Above this amount (payload.amount, USD) everything waits for Phil even if the kind is auto-approved. */
  maxAutoDollars: number;
  /** Bulk actions (archive, label…) touching more than this many items wait for Phil even if the kind is auto-approved. */
  maxAutoItems?: number;
}

export interface AgentConfig {
  persona: Persona;
  model?: ModelKey | null;
  schedule?: AgentSchedule | null;
  rules: ApprovalRules;
  /** Tool names this agent may call (Claude agents only in this phase). */
  tools: string[];
  /**
   * Charter tools Phil switched off for this agent. The charter is the floor: a tool added to it later (a new
   * connector) reaches the agent even when its settings were saved before, unless Phil turned that tool off himself.
   */
  toolsOff?: string[];
  /** Google accounts (emails) this agent may use. Empty = all connected accounts. */
  accounts?: string[];
}

export const DEFAULT_CONFIG: AgentConfig = { persona: {}, model: null, schedule: null, rules: { autoApprove: [], maxAutoDollars: 0 }, tools: [] };

const key = (id: string) => `agentcfg:${id}`;

/** Defaults from the agent's charter: its tools and approval rules until Phil changes them. */
export function charterDefaults(id: string): Pick<AgentConfig, "tools" | "rules"> {
  const ch = CHARTERS[id];
  return {
    tools: ch?.tools ?? [],
    rules: { ...DEFAULT_CONFIG.rules, autoApprove: ch?.autoApprove ?? [], maxAutoDollars: ch?.maxAutoDollars ?? 0 },
  };
}

/** The tools an agent may call: its charter's, plus what Phil added, minus what Phil switched off. */
export function effectiveTools(id: string, saved: Partial<Pick<AgentConfig, "tools" | "toolsOff">>): string[] {
  const off = new Set(saved.toolsOff ?? []);
  return [...new Set([...charterDefaults(id).tools, ...(saved.tools ?? [])])].filter((t) => !off.has(t));
}

export async function getAgentConfig(store: Store, id: string): Promise<AgentConfig> {
  const c = await store.settings.get<Partial<AgentConfig>>(key(id), {});
  const d = charterDefaults(id);
  return { ...DEFAULT_CONFIG, ...c, persona: { ...DEFAULT_CONFIG.persona, ...(c.persona ?? {}) }, rules: { ...d.rules, ...(c.rules ?? {}) }, tools: effectiveTools(id, c), toolsOff: c.toolsOff ?? [] };
}

export async function setAgentConfig(store: Store, id: string, patch: Partial<AgentConfig>): Promise<AgentConfig> {
  const raw = await store.settings.get<Partial<AgentConfig>>(key(id), {});
  const cur = await getAgentConfig(store, id);
  const saved: Partial<AgentConfig> = { ...raw, ...patch, persona: { ...cur.persona, ...(patch.persona ?? {}) }, rules: { ...cur.rules, ...(patch.rules ?? {}) } };
  // What's stored is only Phil's difference from the charter: tools he added (tools) and charter tools he switched off
  // (toolsOff). The charter itself is never copied in, so a tool later added to or dropped from the charter reaches
  // the agent, and a save that only touches rules or persona leaves the tools as they were.
  const charter = charterDefaults(id).tools;
  if (patch.tools) {
    saved.toolsOff = patch.toolsOff ?? charter.filter((t) => !patch.tools!.includes(t));
    saved.tools = patch.tools.filter((t) => !charter.includes(t));
  } else {
    saved.tools = raw.tools;
    saved.toolsOff = raw.toolsOff;
  }
  await store.settings.set(key(id), saved);
  return getAgentConfig(store, id);
}

export function personaText(p: Persona): string {
  const rows: [string, string | undefined][] = [
    ["Reports to", p.reportsTo], ["Job in one sentence", p.job], ["What you do daily / on demand", p.daily], ["Tools and accounts you need", p.tools],
    ["What you may do alone vs. needs approval", p.alone], ["Approval notes", p.approval], ["Preferred AI", p.preferredAI], ["What \"good\" looks like", p.good],
  ];
  const filled = rows.filter(([, v]) => v && v.trim());
  return filled.length ? filled.map(([k, v]) => `- ${k}: ${v!.trim()}`).join("\n") : "";
}
