import type { ApprovalKind } from "./events.js";
import type { ModelKey } from "./registry/agents.js";
import type { Store } from "./store/types.js";

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
  /** Google accounts (emails) this agent may use. Empty = all connected accounts. */
  accounts?: string[];
}

export const DEFAULT_CONFIG: AgentConfig = { persona: {}, model: null, schedule: null, rules: { autoApprove: [], maxAutoDollars: 0 }, tools: [] };

const key = (id: string) => `agentcfg:${id}`;

export async function getAgentConfig(store: Store, id: string): Promise<AgentConfig> {
  const c = await store.settings.get<Partial<AgentConfig>>(key(id), {});
  return { ...DEFAULT_CONFIG, ...c, persona: { ...DEFAULT_CONFIG.persona, ...(c.persona ?? {}) }, rules: { ...DEFAULT_CONFIG.rules, ...(c.rules ?? {}) }, tools: c.tools ?? [] };
}

export async function setAgentConfig(store: Store, id: string, patch: Partial<AgentConfig>): Promise<AgentConfig> {
  const cur = await getAgentConfig(store, id);
  const next: AgentConfig = { ...cur, ...patch, persona: { ...cur.persona, ...(patch.persona ?? {}) }, rules: { ...cur.rules, ...(patch.rules ?? {}) } };
  await store.settings.set(key(id), next);
  return next;
}

export function personaText(p: Persona): string {
  const rows: [string, string | undefined][] = [
    ["Reports to", p.reportsTo], ["Job in one sentence", p.job], ["What you do daily / on demand", p.daily], ["Tools and accounts you need", p.tools],
    ["What you may do alone vs. needs approval", p.alone], ["Approval notes", p.approval], ["Preferred AI", p.preferredAI], ["What \"good\" looks like", p.good],
  ];
  const filled = rows.filter(([, v]) => v && v.trim());
  return filled.length ? filled.map(([k, v]) => `- ${k}: ${v!.trim()}`).join("\n") : "";
}
