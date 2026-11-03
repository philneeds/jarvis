import type { AgentDef, Venture, VentureId, ModelSpec, ModelKey, SystemStatus, UsageSummary, ChatMessage, Approval, ActivityEntry, Schedule } from "@jarvis/core";

export type { AgentDef, Venture, VentureId, ModelSpec, ModelKey, SystemStatus, UsageSummary, ChatMessage, Approval, ActivityEntry, Schedule };

export type AgentLive = AgentDef & {
  live: boolean;
  model: ModelKey;
  status: string;
  lastRunAt?: string;
  lastError?: string;
  detail?: string;
};

export interface State {
  agents: AgentLive[];
  ventures: Record<VentureId, Venture>;
  models: Record<ModelKey, ModelSpec>;
  status: SystemStatus;
  pendingApprovals: number;
  usage: UsageSummary;
  providers: Record<string, { ok: boolean; reason?: string }>;
  schedules: Schedule[];
}
