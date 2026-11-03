import type { ActivityEntry, Approval, ChatMessage } from "../events.js";

export interface RunRecord {
  id: string;
  agentId: string;
  provider?: string;
  modelId?: string;
  prompt: string;
  output?: string;
  status: "running" | "done" | "error" | "blocked";
  error?: string;
  startedAt: string;
  finishedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  parentRunId?: string;
}

export interface UsageRecord {
  id: string;
  at: string;
  plan: string;
  provider: string;
  agentId: string;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  runId?: string;
}

export interface MemoryItem {
  scope: string;
  key: string;
  value: string;
  source?: string;
  updatedAt: string;
}

export interface AgentStateRow {
  id: string;
  status: string;
  paused: boolean;
  lastRunAt?: string;
  lastRunId?: string;
  lastError?: string;
  modelOverride?: string;
  detail?: string;
}

export interface Store {
  kind: "memory" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;
  chat: {
    add(m: ChatMessage): Promise<void>;
    list(limit?: number): Promise<ChatMessage[]>;
  };
  runs: {
    add(r: RunRecord): Promise<void>;
    update(id: string, patch: Partial<RunRecord>): Promise<void>;
    get(id: string): Promise<RunRecord | undefined>;
  };
  activity: {
    add(e: ActivityEntry): Promise<void>;
    list(opts?: { q?: string; agentId?: string; limit?: number }): Promise<ActivityEntry[]>;
  };
  approvals: {
    add(a: Approval): Promise<void>;
    list(status?: Approval["status"]): Promise<Approval[]>;
    get(id: string): Promise<Approval | undefined>;
    update(id: string, patch: Partial<Approval>): Promise<Approval | undefined>;
  };
  usage: {
    add(u: UsageRecord): Promise<void>;
    since(at: Date): Promise<UsageRecord[]>;
  };
  memory: {
    get(scope: string, key: string): Promise<MemoryItem | undefined>;
    set(item: Omit<MemoryItem, "updatedAt">): Promise<void>;
    list(scope?: string): Promise<MemoryItem[]>;
    remove(scope: string, key: string): Promise<void>;
  };
  agentState: {
    get(id: string): Promise<AgentStateRow | undefined>;
    set(id: string, patch: Partial<AgentStateRow>): Promise<AgentStateRow>;
    all(): Promise<AgentStateRow[]>;
  };
  settings: {
    get<T>(key: string, fallback: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
  };
}
