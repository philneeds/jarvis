import { EventEmitter } from "node:events";

export type AgentStatus = "idle" | "working" | "waiting" | "error" | "paused";

export type JarvisEvent =
  | { type: "agent.status"; agentId: string; status: AgentStatus; detail?: string; at: string }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.stream"; runId: string; agentId: string; delta: string }
  | { type: "approval.new"; approval: Approval }
  | { type: "approval.decided"; approval: Approval }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "usage"; usage: UsageSummary }
  | { type: "system"; status: SystemStatus };

export interface ChatMessage {
  id: string;
  at: string;
  role: "phil" | "jarvis" | "agent" | "system";
  agentId?: string;
  text: string;
  runId?: string;
  /** Which agents contributed, for the chat card. */
  via?: string[];
}

export type ApprovalKind = "send" | "post" | "money" | "strategy" | "config" | "record" | "other";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "edited";

export interface Approval {
  id: string;
  at: string;
  agentId: string;
  kind: ApprovalKind;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  status: ApprovalStatus;
  decidedAt?: string;
  note?: string;
  runId?: string;
}

export interface ActivityEntry {
  id: string;
  at: string;
  agentId: string;
  kind: "run" | "delegate" | "approval" | "decision" | "schedule" | "system" | "error" | "memory";
  summary: string;
  detail?: Record<string, unknown>;
  runId?: string;
}

export interface PlanUsage {
  plan: "claude" | "supergrok" | "chatgpt" | "cursor" | "higgsfield";
  label: string;
  /** Estimated share of the plan's pool used in the current window, 0..1. */
  used: number;
  /** Human-readable cap, e.g. "weekly pool". */
  window: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  throttled: boolean;
  perAgent: { agentId: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number }[];
}

export interface UsageSummary {
  at: string;
  plans: PlanUsage[];
}

export interface SystemStatus {
  level: "green" | "yellow" | "orange" | "red";
  text: string;
  killSwitch: { all: boolean; trading: boolean; agents: string[] };
  phase: number;
  at: string;
}

export class JarvisBus extends EventEmitter {
  emitEvent(e: JarvisEvent) {
    this.emit("event", e);
  }
  onEvent(fn: (e: JarvisEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export const bus = new JarvisBus();
bus.setMaxListeners(100);
