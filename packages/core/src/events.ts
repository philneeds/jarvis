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
  | { type: "goals"; goals: Goal[] }
  /** Trophies, levels, today's three or the streak changed: screens that show them fetch the summary again. */
  | { type: "base" }
  /** An agent did something reversible on its own, or Phil undid one. */
  | { type: "autodone" };

/** Something an agent did on its own because HQ can put it back. `snapshot` is what it looked like before. */
export interface AutoDone { id: string; at: string; approvalId: string; agentId: string; title: string; action: string; outcome: string; snapshot?: unknown; after?: string; undone?: { at: string; result: string } }

/** How far out a goal sits. */
export type Horizon = "long" | "mid" | "short";

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
  /** Long, mid or short term. When unset it's read off the deadline (see horizonOf). */
  horizon?: Horizon;
  /** The venture this goal belongs to; its benchmarks and completion level that venture's building. */
  venture?: string;
  /** The longer-term goal this one feeds. */
  parent?: string;
}

/** Something that was really achieved: a benchmark met, or a goal finished. The base's levels are counted from these. */
export interface Trophy { id: string; at: string; title: string; goalId: string; goalName: string; venture?: string; kind: "benchmark" | "goal" }

/** A venture's level (1 to 5): `hits` milestone points so far, `next` the points that reach the next level. */
export interface VentureLevel { level: number; hits: number; next?: number }

/** One of today's three. `ref` ties it to the thing that completes it, so it ticks itself. */
export interface TodayItem { id: string; text: string; goalId?: string; venture?: string; done: boolean; doneAt?: string; ref?: { kind: "approval" | "attention" | "benchmark"; id: string; goalId?: string } }
/** Today's three: picked by David in the morning, or by HQ's own rule when he hasn't. `date` is Phil's day. */
export interface Today { date: string; items: TodayItem[]; by: "david" | "auto" | "phil"; pickedAt: string }

/** Is a live agent ready to work: its connections in place and tried at least once? */
export interface AgentSetup { id: string; name: string; venture: string; missing: string[]; tried: boolean; error?: string; ok: boolean }

/** What the base and the Goals screen show beside the goals themselves. */
export interface BaseSummary { trophies: Trophy[]; levels: Record<string, VentureLevel>; today: Today; streak: number; player: PlayerLevel }

/** Phil's own level, from what he actually got done (see playerXp). `xp` is into this level, `next` what it takes to reach the next. */
export interface PlayerLevel { level: number; total: number; xp: number; next: number; from: { trophies: number; fullDays: number; todosDone: number; decisions: number } }

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
  /** Phil talking the task over with the agents on it. */
  thread?: TaskMessage[];
  /** The agent writing a reply right now, so the screen can say so. */
  replying?: string;
}

/** One line in a task's conversation: Phil, or the agent who answered. */
export interface TaskMessage { at: string; from: "phil" | "agent"; agentId?: string; text: string }

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
  /** Files on the message (decks agents made, documents Phil attached), served at /api/files/<id>. */
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
