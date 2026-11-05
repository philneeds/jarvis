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
        text = `(${label}) Here's the rundown.\n\n${reports.map((m) => `**${m[1]}** — ${m[2]!.trim().split("\n")[0]!.slice(0, 160)}`).join("\n")}\n\nAnything an agent flagged for approval is waiting in Needs you.`;
      } else if (req.agent.id === "jarvis") {
        text = `(${label}) Here's the rundown.\n\n${req.prompt.slice(0, 600)}`;
      } else if (/Phil has a question about a proposal of yours/.test(req.prompt)) {
        // Approval Q&A: answer, and revise the text when Phil asks for a change.
        const q = req.prompt.match(/Phil asks: ([\s\S]*?)\n\nIf his question/)?.[1]?.trim() ?? "";
        const body = req.prompt.match(/\):\n([\s\S]*?)\n\n(?:What you had seen|Payload|Earlier|Phil asks)/)?.[1] ?? "";
        text = /shorter|change|make it|rewrite|add|remove/i.test(q)
          ? `(${label}) Done, I ${/shorter/i.test(q) ? "cut it down" : "changed it as you asked"}.\n\n\`\`\`revise\n${JSON.stringify({ body: `${body.split("\n")[0]!.slice(0, 80)} (revised: ${q.slice(0, 40)})`, context: "They wrote on Tue 3 Nov: \"any update on the quote?\"" })}\n\`\`\``
          : `(${label}) ${req.agent.name} here. ${q ? `On "${q.slice(0, 60)}": ` : ""}they last wrote on Tue 3 Nov asking for an update on the quote, so a short reply today keeps it warm.`;
      } else {
        text = `(${label}) ${req.agent.name} here — ${req.agent.short}. ${req.prompt.slice(0, 200)}`;
        if (/\b(send|email|post|tweet|transfer|trade|invoice)\b/i.test(req.prompt)) {
          const kind = /transfer|trade/i.test(req.prompt) ? "money" : /post|tweet/i.test(req.prompt) ? "post" : "send";
          const who = req.prompt.match(/\b(?:to|email)\s+([A-Z][\w']+(?: [A-Z][\w']+)?)/)?.[1];
          const bodyText = `(${label}) Hi${who ? ` ${who.split(" ")[0]}` : ""}, following up on the kitchen quote we sent last week. Happy to walk through it whenever suits. ${req.agent.name.split(" ")[0]}`;
          const payload = kind === "send" && who ? { action: "gmail.send", to: `${who.toLowerCase().replace(/\W+/g, ".")}@example.com`, subject: "Following up on your kitchen quote", body: bodyText, account: "phil@example.com" } : { from: req.agent.id };
          text += `\n\nDraft is ready; it needs your OK.\n\n\`\`\`approval\n${JSON.stringify({ kind, title: `${req.agent.name}: ${req.prompt.replace(/^.*?asks:\s*/s, "").slice(0, 60)}`, body: kind === "send" && who ? bodyText : `(${label}) This is what would go out, word for word. Edit it here or approve as is.`, payload, context: who ? `${who} <${who.toLowerCase().replace(/\W+/g, ".")}@example.com> wrote on Tue 3 Nov: "Thanks for the quote, let me think it over." No reply since.` : undefined })}\n\`\`\``;
        }
        if (/\blog (a )?lead\b/i.test(req.prompt) && req.agent.venture === "jdpm") {
          const who = req.prompt.match(/lead\s+(?:for|from)?\s*([A-Z][\w']+(?: [A-Z][\w']+)?)/)?.[1] ?? "New lead";
          text += `\n\n\`\`\`record\n${JSON.stringify({ venture: "jdpm", kind: "lead", title: who, status: "new", fields: { source: "referral", value: 4200 } })}\n\`\`\`\n\`\`\`metric\n${JSON.stringify({ venture: "jdpm", key: "leads_week", value: 1 + Math.floor(Math.random() * 5) })}\n\`\`\``;
        }
        if (/remember|note that/i.test(req.prompt)) {
          text += `\n\n\`\`\`remember\n${JSON.stringify({ scope: `venture:${req.agent.venture}`, key: "note-" + Date.now().toString(36), value: req.prompt.replace(/^.*?asks:\s*/s, "").slice(0, 120) })}\n\`\`\``;
        }
      }
      if (req.images?.length) text = `(saw ${req.images.length} image${req.images.length > 1 ? "s" : ""}) ${text}`;
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
