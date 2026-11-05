import type { AgentDef, Venture, VentureId, ModelSpec, ModelKey, SystemStatus, UsageSummary, ChatMessage, Approval, ActivityEntry, Schedule, MetricDef, RecordKindDef, AttentionItem } from "@jarvis/core";

export type { AgentDef, Venture, VentureId, ModelSpec, ModelKey, SystemStatus, UsageSummary, ChatMessage, Approval, ActivityEntry, Schedule, MetricDef, RecordKindDef, AttentionItem };

export type AgentLive = AgentDef & {
  live: boolean;
  model: ModelKey;
  status: string;
  lastRunAt?: string;
  lastError?: string;
  detail?: string;
  /** The agent's own successful runs since midnight, Phil's time. */
  runsToday?: number;
};

export interface State {
  agents: AgentLive[];
  ventures: Record<VentureId, Venture>;
  models: Record<ModelKey, ModelSpec>;
  status: SystemStatus;
  pendingApprovals: number;
  waiting: number;
  usage: UsageSummary;
  providers: Record<string, { ok: boolean; reason?: string }>;
  schedules: Schedule[];
}
