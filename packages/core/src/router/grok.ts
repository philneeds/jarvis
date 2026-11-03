import { spawn } from "node:child_process";
import type { AgentRequest, AgentResult, Provider } from "./types.js";
import { ProviderError } from "./types.js";

/**
 * Grok provider. Default mode calls the Grok Build CLI non-interactively (`grok -p "<prompt>"`),
 * which runs on Phil's SuperGrok plan after `grok login`. Fallback: the xAI API with XAI_API_KEY.
 *   GROK_BIN   binary name or path (default "grok")
 *   GROK_ARGS  extra args, space-separated (default "-p")
 *   GROK_MODE  "cli" (default) or "api"
 */
export function grokProvider(mode = process.env.GROK_MODE || "cli"): Provider {
  return mode === "api" ? grokApiProvider() : grokCliProvider();
}

export function grokCliProvider(): Provider {
  const bin = process.env.GROK_BIN || "grok";
  const extra = (process.env.GROK_ARGS || "-p").split(" ").filter(Boolean);
  return {
    id: "grok:cli",
    async available() {
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(bin, ["--version"], { stdio: "ignore" });
        p.on("error", () => resolve(false));
        p.on("exit", (code) => resolve(code === 0));
      });
      return ok ? { ok } : { ok, reason: `'${bin}' not found or not logged in (run: grok login)` };
    },
    async run(req: AgentRequest): Promise<AgentResult> {
      const t0 = Date.now();
      const prompt = `${req.system}\n\n---\n\n${req.prompt}`;
      const args = [...extra, prompt];
      const text = await new Promise<string>((resolve, reject) => {
        let out = "", err = "";
        const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
        req.signal?.addEventListener("abort", () => p.kill("SIGTERM"));
        p.stdout.on("data", (d) => { const s = d.toString(); out += s; req.onDelta?.(s); });
        p.stderr.on("data", (d) => { err += d.toString(); });
        p.on("error", (e) => reject(new ProviderError(`Could not start '${bin}': ${e.message}`, "grok:cli", e)));
        p.on("exit", (code) => {
          if (code === 0) resolve(out);
          else reject(new ProviderError(`grok exited ${code}: ${err.trim() || out.trim()}`.slice(0, 500), "grok:cli"));
        });
      });
      const approxIn = Math.ceil(prompt.length / 4), approxOut = Math.ceil(text.length / 4);
      return {
        text: text.trim(),
        provider: "grok:cli",
        modelId: req.model.modelId ?? "grok",
        inputTokens: approxIn,
        outputTokens: approxOut,
        costUsd: 0,
        durationMs: Date.now() - t0,
      };
    },
  };
}

export function grokApiProvider(): Provider {
  return {
    id: "grok:api",
    async available() {
      return process.env.XAI_API_KEY ? { ok: true } : { ok: false, reason: "XAI_API_KEY not set" };
    },
    async run(req: AgentRequest): Promise<AgentResult> {
      const t0 = Date.now();
      const res = await fetch(process.env.XAI_BASE_URL || "https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.XAI_API_KEY}` },
        body: JSON.stringify({
          model: req.model.modelId ?? "grok-4",
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new ProviderError(`xAI API ${res.status}: ${(await res.text()).slice(0, 300)}`, "grok:api");
      const j = (await res.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const text = j.choices?.[0]?.message?.content ?? "";
      req.onDelta?.(text);
      const input = j.usage?.prompt_tokens ?? 0, output = j.usage?.completion_tokens ?? 0;
      return {
        text: text.trim(),
        provider: "grok:api",
        modelId: j.model ?? req.model.modelId ?? "grok",
        inputTokens: input,
        outputTokens: output,
        costUsd: (input * 3 + output * 15) / 1_000_000,
        durationMs: Date.now() - t0,
      };
    },
  };
}
