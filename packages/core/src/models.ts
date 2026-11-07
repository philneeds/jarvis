import type { ModelKey } from "./registry/agents.js";

export type ProviderId = "claude" | "grok" | "manual" | "none";

export interface ModelSpec {
  key: ModelKey;
  label: string;
  provider: ProviderId;
  /** Provider-specific model id. Overridable with env (CLAUDE_OPUS_MODEL etc.). */
  modelId?: string;
  /** Which paid plan this draws on, for the usage screen. */
  plan: "claude" | "supergrok" | "chatgpt" | "cursor" | "higgsfield" | "none";
  why: string;
}

const env = (k: string, d: string) => (typeof process !== "undefined" && process.env[k]) || d;

/**
 * The model catalog. Sonnet is the base for every Claude agent; Opus runs anything that moves money,
 * steers a business or writes code; Grok agents scout and draft. No Haiku.
 */
export const MODELS: Record<ModelKey, ModelSpec> = {
  "claude-fable": {
    key: "claude-fable", label: "Claude Fable", provider: "claude", plan: "claude",
    modelId: env("CLAUDE_FABLE_MODEL", "claude-fable-5-1"),
    why: "The most capable model, for engineering HQ itself and the hardest judgment calls; about 2.5x Opus per token.",
  },
  "claude-opus": {
    key: "claude-opus", label: "Claude Opus", provider: "claude", plan: "claude",
    modelId: env("CLAUDE_OPUS_MODEL", "claude-opus-5-5"),
    why: "Decisions that move money or a business, advice, and code.",
  },
  "claude-sonnet": {
    key: "claude-sonnet", label: "Claude Sonnet", provider: "claude", plan: "claude",
    modelId: env("CLAUDE_SONNET_MODEL", "claude-sonnet-5-5"),
    why: "Tool work in Phil's accounts at a sustainable cost.",
  },
  grok: {
    key: "grok", label: "Grok", provider: "grok", plan: "supergrok",
    modelId: env("GROK_MODEL", "grok-4.7"),
    why: "Scouting and drafting in Phil's X voice; X itself is read through xAI's X search, which HQ runs for every model.",
  },
  cursor: { key: "cursor", label: "Cursor", provider: "manual", plan: "cursor", why: "Second coding brain that builds and reviews alongside Jason." },
  higgsfield: { key: "higgsfield", label: "Higgsfield + image/video models", provider: "manual", plan: "higgsfield", why: "Images, video and visual assets." },
  "chatgpt-health": { key: "chatgpt-health", label: "ChatGPT Health", provider: "manual", plan: "chatgpt", why: "Coaches where Phil's Apple Health data lives; not available by API." },
  "web-app": { key: "web-app", label: "Web app", provider: "none", plan: "none", why: "HQ itself." },
};

export function modelFor(key: ModelKey): ModelSpec {
  return MODELS[key];
}
