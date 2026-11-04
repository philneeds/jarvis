import { spawn } from "node:child_process";
import type { AgentRequest, AgentResult, Provider } from "./types.js";
import { ProviderError } from "./types.js";

/**
 * Grok provider. Default mode calls the Grok Build CLI headless (`grok ... -p "<prompt>"`), which runs on
 * Phil's SuperGrok plan after `grok login`. Scouts use Grok's built-in web/X search, which is read-only and
 * needs no approval; in headless mode anything that WOULD need approval (shell, file edits) is denied rather
 * than left hanging, and a turn budget keeps a scout from looping. Fallback: the xAI API with XAI_API_KEY.
 *   GROK_BIN   binary name or path (default "grok")
 *   GROK_ARGS  args before the prompt, space-separated (default "--permission-mode dontAsk --max-turns 8 -p")
 *   GROK_MODE  "cli" (default) or "api"
 */
export function grokProvider(mode = process.env.GROK_MODE || "cli"): Provider {
  return mode === "api" ? grokApiProvider() : grokCliProvider();
}

export function grokCliProvider(): Provider {
  const bin = process.env.GROK_BIN || "grok";
  const extra = (process.env.GROK_ARGS || "--permission-mode dontAsk --max-turns 8 -p").split(" ").filter(Boolean);
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
        // A scout stuck on something interactive must not hold the run forever.
        const t = setTimeout(() => { p.kill("SIGTERM"); reject(new ProviderError("grok timed out after 5 minutes", "grok:cli")); }, Number(process.env.GROK_TIMEOUT_MS ?? 300_000));
        p.on("exit", () => clearTimeout(t));
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
