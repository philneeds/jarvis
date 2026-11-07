import { EventEmitter } from "node:events";

export type AgentStatus = "idle" | "working" | "waiting" | "error" | "paused";

export type JarvisEvent =
  | { type: "agent.status"; agentId: string; status: AgentStatus; detail?: string; at: string }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.stream"; runId: string; agentId: string; delta: string }
  | { type: "approval.new"; approval: Approval }
  | { type: "approval.decided"; approval: Approval }
  | { type: "approval.updated"; approval: Approval }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "usage"; usage: UsageSummary }
  | { type: "system"; status: SystemStatus }
  | { type: "venture"; venture: string }
  | { type: "brief"; text: string; at: string }
  /** A scheduled report meant for Phil's phone as well as HQ (the brief, Monica's day plan). */
  | { type: "report"; agentId: string; title: string; text: string; at: string; files?: { id: string; name: string }[] }
  | { type: "attention"; item: AttentionItem; change: "raised" | "done" | "snoozed" | "reopened" | "edited" }
  | { type: "goals"; goals: Goal[] };

/** One of Phil's goals. Exactly one is primary whenever there are any. */
export interface Goal {
  id: string;
  name: string;
  /** Percent done, 0..100. */
  pct: number;
  /** YYYY-MM-DD. */
  deadline?: string;
  primary: boolean;
  updatedAt: string;
  /** What moves the bar: David sets these for each goal; done benchmarks' weights add up to the percent. */
  benchmarks?: Benchmark[];
}

export interface Benchmark { id: string; text: string; weight: number; done: boolean; doneAt?: string }

/** Something Phil has to act on. Lives until he ticks it off; raised by agents or by Phil. */
export interface AttentionItem {
  id: string;
  at: string;
  title: string;
  why: string;
  agentId: string;
  venture?: string;
  due?: string;
  status: "open" | "snoozed" | "done";
  snoozedUntil?: string;
  doneAt?: string;
  source?: { runId?: string; approvalId?: string };
}

export interface ChatMessage {
  id: string;
  at: string;
  role: "phil" | "jarvis" | "agent" | "system";
  agentId?: string;
  text: string;
  runId?: string;
  /** Which agents contributed, for the chat card. */
  via?: string[];
  /** Where the conversation came from; replies inherit it so Telegram answers go back to Telegram. */
  channel?: "hq" | "telegram" | "voice" | "schedule";
  /** The Phil message this answers. */
  replyTo?: string;
  /** ack = "on it" within seconds; progress = someone finished late; final = the answer. */
  kind?: "ack" | "progress" | "final";
  /** Images Phil attached (upload ids, served at /api/uploads/<id>). */
  images?: string[];
  /** Files handed to Phil (decks), served at /api/files/<id>. */
  files?: { id: string; name: string }[];
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
  /** What the agent saw: who this is, what they last said (quoted, dated), the numbers behind the ask. */
  context?: string;
  /** Plain words for what happens the moment Phil approves. Computed from the payload's action, never by the agent. */
  effect?: string;
  /** Phil's questions about the proposal and the agent's answers. */
  thread?: ApprovalMessage[];
  /** Set once the text changed after the agent proposed it; the agent's original is kept here. */
  original?: string;
  /** Who changed it last: Phil on the card, or the agent at Phil's request. */
  editedBy?: "phil" | "agent";
  status: ApprovalStatus;
  decidedAt?: string;
  note?: string;
  runId?: string;
}

export interface ApprovalMessage { at: string; from: "phil" | "agent"; text: string }

export const ACTIVITY_KINDS = ["run", "delegate", "approval", "decision", "schedule", "system", "error", "memory"] as const;

export interface ActivityEntry {
  id: string;
  at: string;
  agentId: string;
  /** "run" is one line per model call: useful for tracing, noise for reading. HQ hides it unless asked. */
  kind: (typeof ACTIVITY_KINDS)[number];
  summary: string;
  detail?: Record<string, unknown>;
  runId?: string;
}

export interface PlanUsage {
  plan: "claude" | "supergrok" | "xai" | "chatgpt" | "cursor" | "higgsfield";
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
