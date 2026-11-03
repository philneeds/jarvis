import type { AgentDef } from "../registry/agents.js";
import type { ModelSpec } from "../models.js";
import type { ToolContext, ToolDef } from "../tools/index.js";

export interface AgentRequest {
  agent: AgentDef;
  model: ModelSpec;
  system: string;
  prompt: string;
  runId: string;
  /** Called with text deltas when the provider streams. */
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  maxTurns?: number;
  /** Tools the agent may call (providers that support tool use). */
  tools?: ToolDef[];
  toolContext?: ToolContext;
}

export interface AgentResult {
  text: string;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  raw?: unknown;
}

export interface Provider {
  id: string;
  /** Whether the provider can run right now (binary present, key set, etc). */
  available(): Promise<{ ok: boolean; reason?: string }>;
  run(req: AgentRequest): Promise<AgentResult>;
}

export class ProviderError extends Error {
  constructor(message: string, public provider: string, public cause?: unknown) {
    super(message);
    this.name = "ProviderError";
  }
}
