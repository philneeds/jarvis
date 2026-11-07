import type { AgentRequest, AgentResult, Provider } from "./types.js";
import { ProviderError } from "./types.js";
import { BUILTIN_TOOL_NAMES } from "../lookup.js";
import type { ToolDef } from "../tools/index.js";

/** HQ tools go through the in-process MCP server; web_search and web_fetch become Claude's own WebSearch and WebFetch. */
export function splitTools(all: ToolDef[]): { hq: ToolDef[]; builtins: string[] } {
  return { hq: all.filter((t) => !BUILTIN_TOOL_NAMES[t.name]), builtins: all.filter((t) => BUILTIN_TOOL_NAMES[t.name]).map((t) => BUILTIN_TOOL_NAMES[t.name]!) };
}

/**
 * Claude provider. Two modes:
 *  - "agent-sdk" (default): runs through the Claude Agent SDK, which uses the Claude Code sign-in on
 *    Phil's plan. Works wherever `claude` is logged in. Set CLAUDE_MODE=agent-sdk.
 *  - "api": calls the Messages API directly with ANTHROPIC_API_KEY (pay-as-you-go fallback).
 * If the chosen mode fails with an auth error and the other is configured, the router falls back.
 */
export type ClaudeMode = "agent-sdk" | "api";

export function claudeProvider(mode: ClaudeMode = (process.env.CLAUDE_MODE as ClaudeMode) || "agent-sdk"): Provider {
  return mode === "api" ? claudeApiProvider() : claudeAgentSdkProvider();
}

export function claudeAgentSdkProvider(): Provider {
  return {
    id: "claude:agent-sdk",
    async available() {
      try {
        await import("@anthropic-ai/claude-agent-sdk");
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "Claude Agent SDK not installed" };
      }
    },
    async run(req: AgentRequest): Promise<AgentResult> {
      const t0 = Date.now();
      const { query, createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
      const { hq: tools, builtins } = splitTools(req.tools ?? []);
      const mcp = tools.length
        ? createSdkMcpServer({
            name: "jarvis",
            version: "0.1.0",
            instructions: "HQ tools. Read-only: anything that changes the world goes through an approval block.",
            tools: tools.map((t) => tool(t.name, t.description, t.schema, async (args) => {
              try {
                const text = await t.handler(args as never, req.toolContext ?? { store: undefined as never, agentId: req.agent.id });
                return { content: [{ type: "text", text }] };
              } catch (e) {
                return { content: [{ type: "text", text: `tool failed: ${(e as Error).message}` }], isError: true };
              }
            })),
          })
        : undefined;
      let text = "";
      let input = 0, output = 0, cost = 0;
      let resultText: string | undefined;
      let error: string | undefined;
      const abort = new AbortController();
      req.signal?.addEventListener("abort", () => abort.abort());
      try {
        // With images, the prompt is one user message carrying the pictures and the text.
        const prompt = req.images?.length
          ? (async function* () {
              yield { type: "user" as const, parent_tool_use_id: null, message: { role: "user" as const, content: [...req.images!.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mime as "image/jpeg", data: im.data } })), { type: "text" as const, text: req.prompt }] } };
            })()
          : req.prompt;
        const q = query({
          prompt,
          options: {
            model: req.model.modelId,
            systemPrompt: req.system,
            maxTurns: req.maxTurns ?? (tools.length || builtins.length ? 8 : 2),
            // Only HQ tools and the web, never the CLI's file/shell tools.
            allowedTools: [...tools.map((t) => `mcp__jarvis__${t.name}`), ...builtins],
            tools: builtins,
            ...(mcp ? { mcpServers: { jarvis: mcp } } : {}),
            permissionMode: "dontAsk",
            persistSession: false,
            settingSources: [],
            abortController: abort,
            cwd: process.env.JARVIS_AGENT_CWD || process.cwd(),
          },
        });
        for await (const msg of q) {
          if (msg.type === "assistant") {
            if (msg.error) error = msg.error;
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                text += block.text;
                req.onDelta?.(block.text);
              }
            }
          } else if (msg.type === "result") {
            if (msg.subtype === "success") {
              resultText = msg.result;
            } else {
              error = error ?? msg.subtype;
            }
            const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
            input = u?.input_tokens ?? 0;
            output = u?.output_tokens ?? 0;
            cost = (msg as { total_cost_usd?: number }).total_cost_usd ?? 0;
          }
        }
      } catch (e) {
        // The SDK throws after the stream ends when the run stopped on an error. A turn-limit stop
        // after the model already answered is still an answer; keep the text rather than failing the run.
        const msg = (e as Error).message ?? String(e);
        if (!/maximum number of turns/i.test(msg) || !(text || resultText)) {
          throw new ProviderError(`Claude Agent SDK failed: ${msg}`, "claude:agent-sdk", e);
        }
      }
      if (error && !text && !resultText) {
        throw new ProviderError(`Claude Agent SDK error: ${error}`, "claude:agent-sdk");
      }
      // With tools, the SDK's final result is the answer; the per-turn text blocks are "I'll look that up" progress notes.
      return {
        text: ((tools.length ? resultText : undefined) || text || resultText || "").trim(),
        provider: "claude:agent-sdk",
        modelId: req.model.modelId ?? "claude",
        inputTokens: input,
        outputTokens: output,
        costUsd: cost,
        durationMs: Date.now() - t0,
      };
    },
  };
}

export function claudeApiProvider(): Provider {
  return {
    id: "claude:api",
    async available() {
      return process.env.ANTHROPIC_API_KEY
        ? { ok: true }
        : { ok: false, reason: "ANTHROPIC_API_KEY not set" };
    },
    async run(req: AgentRequest): Promise<AgentResult> {
      const t0 = Date.now();
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic();
      try {
        const stream = client.messages.stream(
          {
            model: req.model.modelId ?? "claude-sonnet-5-5",
            max_tokens: 4096,
            system: req.system,
            messages: [{ role: "user", content: req.images?.length ? [...req.images.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mime as "image/jpeg", data: im.data } })), { type: "text" as const, text: req.prompt }] : req.prompt }],
          },
          { signal: req.signal },
        );
        let text = "";
        stream.on("text", (d) => { text += d; req.onDelta?.(d); });
        const final = await stream.finalMessage();
        const input = final.usage.input_tokens, output = final.usage.output_tokens;
        return {
          text: text.trim(),
          provider: "claude:api",
          modelId: final.model,
          inputTokens: input,
          outputTokens: output,
          costUsd: estimateClaudeCost(final.model, input, output),
          durationMs: Date.now() - t0,
        };
      } catch (e) {
        throw new ProviderError(`Claude API failed: ${(e as Error).message}`, "claude:api", e);
      }
    },
  };
}

/** Rough list-price estimate so the usage screen has a dollar figure for API fallback runs. */
export function estimateClaudeCost(model: string, input: number, output: number): number {
  // List prices: Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 per 1M tokens.
  const [inRate, outRate] = /opus/i.test(model) ? [4, 20] : /haiku/i.test(model) ? [0.1, 0.5] : [2, 10];
  return (input * inRate + output * outRate) / 1_000_000;
}
