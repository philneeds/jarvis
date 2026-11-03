import type { AgentRequest, AgentResult, Provider } from "./types.js";

/**
 * Mock provider for development and tests (JARVIS_MOCK=1). Answers in character, instantly, offline.
 * When the agent is Jarvis, it returns a valid plan so the orchestrator path is exercised end to end.
 */
export function mockProvider(label = "mock"): Provider {
  return {
    id: label,
    async available() { return { ok: true }; },
    async run(req: AgentRequest): Promise<AgentResult> {
      const t0 = Date.now();
      let text: string;
      if (req.agent.id === "jarvis" && /Respond with JSON/.test(req.prompt)) {
        const said = req.prompt.split("Phil says:").pop() ?? "";
        const mentions = [...said.matchAll(/@([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase());
        const plan = {
          reply: mentions.length ? undefined : `(${label}) Noted: "${req.prompt.split("Phil says:").pop()?.trim().slice(0, 120)}". Nothing to delegate.`,
          delegate: mentions.map((id) => ({ agent: id, task: "Give Phil a one-paragraph status in your own voice." })),
        };
        text = JSON.stringify(plan);
      } else if (req.agent.id === "oscar" && /Condense it/.test(req.prompt)) {
        const items = [...req.prompt.matchAll(/^- \[([^\]]+)\] ([^:]+): (.*)$/gm)].map((m) => ({ scope: m[1]!, key: m[2]!, value: m[3]! }));
        const keep = items.filter((_, i) => i % 2 === 0);
        text = JSON.stringify({ keep, dropped: items.length - keep.length, why: `(${label}) merged duplicates, kept the facts` });
      } else if (req.agent.id === "jarvis" && /Reports back from the agents/.test(req.prompt)) {
        const reports = [...req.prompt.matchAll(/^### (.+?) \(@[\w.-]+\) — task: .*\n([\s\S]*?)(?=\n### |\n\nNow answer Phil)/gm)];
        text = `(${label}) Here's the rundown.\n\n${reports.map((m) => `**${m[1]}** — ${m[2]!.trim().split("\n")[0]!.slice(0, 160)}`).join("\n")}\n\nAnything an agent flagged for approval is waiting in Approvals.`;
      } else if (req.agent.id === "jarvis") {
        text = `(${label}) Here's the rundown.\n\n${req.prompt.slice(0, 600)}`;
      } else {
        text = `(${label}) ${req.agent.name} here — ${req.agent.short}. ${req.prompt.slice(0, 200)}`;
        if (/\b(send|email|post|tweet|transfer|trade|invoice)\b/i.test(req.prompt)) {
          text += `\n\nDraft is ready; it needs your OK.\n\n\`\`\`approval\n${JSON.stringify({ kind: /transfer|trade/i.test(req.prompt) ? "money" : /post|tweet/i.test(req.prompt) ? "post" : "send", title: `${req.agent.name}: ${req.prompt.replace(/^.*?asks:\s*/s, "").slice(0, 60)}`, body: `(${label}) This is what would go out, word for word. Edit it here or approve as is.`, payload: { from: req.agent.id } })}\n\`\`\``;
        }
        if (/\blog (a )?lead\b/i.test(req.prompt) && req.agent.venture === "jdpm") {
          const who = req.prompt.match(/lead\s+(?:for|from)?\s*([A-Z][\w']+(?: [A-Z][\w']+)?)/)?.[1] ?? "New lead";
          text += `\n\n\`\`\`record\n${JSON.stringify({ venture: "jdpm", kind: "lead", title: who, status: "new", fields: { source: "referral", value: 4200 } })}\n\`\`\`\n\`\`\`metric\n${JSON.stringify({ venture: "jdpm", key: "leads_week", value: 1 + Math.floor(Math.random() * 5) })}\n\`\`\``;
        }
        if (/remember|note that/i.test(req.prompt)) {
          text += `\n\n\`\`\`remember\n${JSON.stringify({ scope: `venture:${req.agent.venture}`, key: "note-" + Date.now().toString(36), value: req.prompt.replace(/^.*?asks:\s*/s, "").slice(0, 120) })}\n\`\`\``;
        }
      }
      req.onDelta?.(text);
      return {
        text,
        provider: label,
        modelId: req.model.modelId ?? "mock",
        inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
        costUsd: 0,
        durationMs: Date.now() - t0,
      };
    },
  };
}
