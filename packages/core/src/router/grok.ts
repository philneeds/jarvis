import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRequest, AgentResult, Provider } from "./types.js";
import { ProviderError } from "./types.js";

/**
 * Grok provider. Default mode calls the Grok Build CLI headless (`grok ... -p "<prompt>"`), which runs on
 * Phil's SuperGrok plan after `grok login`. Scouts use Grok's built-in web/X search, which is read-only and
 * needs no approval; in headless mode anything that WOULD need approval (shell, file edits) is denied rather
 * than left hanging, and a turn budget keeps a scout from looping. Fallback: the xAI API with XAI_API_KEY.
 * Output is parsed from --output-format json (final text only, no progress lines). Shell, file and
 * media tools are denied and the CLI runs in an empty directory, so a scout can read the web and X and
 * nothing on the server.
 *   GROK_BIN    binary name or path (default "grok")
 *   GROK_ARGS   args before the prompt, space-separated (default below)
 *   GROK_MODE   "cli" (default) or "api"
 *   GROK_CWD    working directory for the CLI (default: an empty temp dir)
 */
export function grokProvider(mode = process.env.GROK_MODE || "cli"): Provider {
  return mode === "api" ? grokApiProvider() : grokCliProvider();
}

export const GROK_DENIED_TOOLS = "run_terminal_command,read_file,search_replace,write,list_dir,grep,spawn_subagent,kill_command_or_subagent,get_command_or_subagent_output,scheduler_create,scheduler_delete,scheduler_list,monitor,search_tool,use_tool,workflow,enter_plan_mode,exit_plan_mode,ask_user_question,send_feedback,image_gen,image_edit,image_to_video,reference_to_video";
export const GROK_DEFAULT_ARGS = `--permission-mode dontAsk --max-turns 14 --output-format json --disallowed-tools ${GROK_DENIED_TOOLS} -p`;
/** The CLI has no X search, and X blocks its pages for servers (HTTP 429, error 1015): whatever an agent needs from X, HQ puts in the task. */
export const GROK_RULES = `Reading X: this environment has no X search. Anything from X that your task needs, HQ has already placed in the task below (an account's recent posts, a search's results). Never fetch x.com, twitter.com or api.twitter.com URLs; those requests are rate-limited and fail. If HQ gave you nothing from X and the task needs it, say in one line that the X read is missing and answer from what you have; don't try to work around it.`;
/** The CLI's stop reasons that mean "ran out of turns", in the spellings seen so far. */
const CUT_SHORT = /max[_ -]?turns|turn[_ -]?limit|max[_ -]?tokens|length/i;
/** A run that looks like it ended mid-work: narration about what it's about to do, with no result after it. */
const NARRATING = /(^|\n)\s*(I['’]ll|I will|Next[,:]|Pulling|Opening|Checking|Searching|Let me)\b[^\n]*\.?\s*$/i;

const grokCwd = () => {
  if (process.env.GROK_CWD) return process.env.GROK_CWD;
  const d = path.join(os.tmpdir(), "jarvis-grok");
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* fall back to cwd */ }
  return d;
};

/** One headless Grok run: the prompt in, the final text out. Used by the provider and by HQ's x_search tool. */
export function grokOnce(prompt: string, opts: { signal?: AbortSignal; timeoutMs?: number; maxTurns?: number } = {}): Promise<string> {
  const bin = process.env.GROK_BIN || "grok";
  let extra = (process.env.GROK_ARGS || GROK_DEFAULT_ARGS).split(" ").filter(Boolean);
  if (opts.maxTurns) { const i = extra.indexOf("--max-turns"); if (i >= 0) extra[i + 1] = String(opts.maxTurns); else extra = ["--max-turns", String(opts.maxTurns), ...extra]; }
  return new Promise<string>((resolve, reject) => {
    let out = "", err = "";
    const p = spawn(bin, [...extra, prompt], { stdio: ["ignore", "pipe", "pipe"], cwd: grokCwd(), env: { ...process.env, NO_COLOR: "1" } });
    opts.signal?.addEventListener("abort", () => p.kill("SIGTERM"));
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => reject(new ProviderError(`Could not start '${bin}': ${e.message}`, "grok:cli", e)));
    p.on("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new ProviderError(`grok exited ${code}: ${err.trim() || out.trim()}`.slice(0, 500), "grok:cli"));
    });
    // A run stuck on something interactive must not hold things forever.
    const t = setTimeout(() => { p.kill("SIGTERM"); reject(new ProviderError(`grok timed out after ${Math.round((opts.timeoutMs ?? 300_000) / 60_000)} minutes`, "grok:cli")); }, opts.timeoutMs ?? Number(process.env.GROK_TIMEOUT_MS ?? 300_000));
    p.on("exit", () => clearTimeout(t));
  });
}

export function grokCliProvider(once: typeof grokOnce = grokOnce): Provider {
  const bin = process.env.GROK_BIN || "grok";
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
      const prompt = `${req.system}\n\n${GROK_RULES}\n\n---\n\n${req.prompt}`;
      let text = await once(prompt, { signal: req.signal });
      let parsed = parseGrokJson(text);
      let finished = (parsed?.text ?? text).trim();
      // Cut off by the turn limit, or stopped while still narrating: one more short pass to write the answer from what it has.
      if ((parsed?.stopReason && CUT_SHORT.test(parsed.stopReason)) || NARRATING.test(finished)) {
        const follow = `${req.system}\n\n---\n\n${req.prompt}\n\n---\n\nYour previous run on this was cut off before you answered. Here is everything you had written so far:\n\n${finished.slice(0, 6000)}\n\nDo not search again. Write the final answer now from what you already found: the result itself (numbers, posts with handles and dates, findings), any remember or handoff blocks, and one line on what you couldn't get. No narration about what you'll do next.`;
        try {
          const text2 = await once(follow, { signal: req.signal, maxTurns: 3 });
          const parsed2 = parseGrokJson(text2);
          const t2 = (parsed2?.text ?? text2).trim();
          if (t2) { text = text2; parsed = parsed2 ?? parsed; finished = t2; }
        } catch { /* keep the first pass */ }
      }
      return {
        text: finished,
        provider: "grok:cli",
        modelId: parsed?.model ?? req.model.modelId ?? "grok",
        inputTokens: parsed?.input ?? Math.ceil(prompt.length / 4),
        outputTokens: parsed?.output ?? Math.ceil(text.length / 4),
        costUsd: 0, // on the plan; the CLI's cost figure is informational
        durationMs: Date.now() - t0,
        raw: parsed ? { stopReason: parsed.stopReason, numTurns: parsed.numTurns, costUsd: parsed.cost } : undefined,
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
          model: req.model.modelId ?? "grok-4.7",
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
        costUsd: (input * 1.25 + output * 2.5) / 1_000_000, // grok-4.x list price per 1M tokens
        durationMs: Date.now() - t0,
      };
    },
  };
}

/** The CLI's --output-format json: {"text","stopReason","num_turns","usage":{...},"modelUsage":{"<model>":{...}}}. */
export function parseGrokJson(raw: string): { text: string; model?: string; input?: number; output?: number; stopReason?: string; numTurns?: number; cost?: number } | undefined {
  const s = raw.trim();
  const first = s.indexOf("{"), last = s.lastIndexOf("}");
  if (first < 0 || last <= first) return undefined;
  try {
    const j = JSON.parse(s.slice(first, last + 1)) as { text?: unknown; stopReason?: string; num_turns?: number; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number }; modelUsage?: Record<string, unknown> };
    if (typeof j.text !== "string") return undefined;
    return { text: j.text, model: j.modelUsage ? Object.keys(j.modelUsage)[0] : undefined, input: j.usage?.input_tokens, output: j.usage?.output_tokens, stopReason: j.stopReason, numTurns: j.num_turns, cost: j.total_cost_usd };
  } catch { return undefined; }
}
