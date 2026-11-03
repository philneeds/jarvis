import type { ApprovalKind } from "../events.js";

export interface ApprovalBlock { kind: ApprovalKind; title: string; body: string; payload?: Record<string, unknown> }
export interface RememberBlock { scope: string; key: string; value: string }

const KINDS: ApprovalKind[] = ["send", "post", "money", "strategy", "config", "record", "other"];

/** Pull fenced ```approval and ```remember JSON blocks out of an agent's reply. */
export function extractBlocks(text: string): { text: string; approvals: ApprovalBlock[]; remember: RememberBlock[] } {
  const approvals: ApprovalBlock[] = [];
  const remember: RememberBlock[] = [];
  const re = /```(approval|remember)\s*\n([\s\S]*?)```/g;
  const cleaned = text.replace(re, (_m, tag: string, body: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(body.trim()); } catch { return _m; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (tag === "approval") {
      for (const it of items) {
        const o = it as Partial<ApprovalBlock>;
        if (!o || typeof o !== "object" || !o.title) continue;
        approvals.push({ kind: KINDS.includes(o.kind as ApprovalKind) ? (o.kind as ApprovalKind) : "other", title: String(o.title), body: String(o.body ?? ""), payload: o.payload && typeof o.payload === "object" ? (o.payload as Record<string, unknown>) : undefined });
      }
      return approvals.length ? `[Approval queued: ${approvals[approvals.length - 1]!.title}]` : _m;
    }
    for (const it of items) {
      const o = it as Partial<RememberBlock>;
      if (!o || typeof o !== "object" || !o.key || o.value === undefined) continue;
      remember.push({ scope: String(o.scope ?? "phil"), key: String(o.key), value: String(o.value) });
    }
    return "";
  });
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), approvals, remember };
}

/** Parse Jarvis's plan JSON, tolerating fences and stray prose around it. */
export function parsePlan(raw: string): { reply?: string; delegate: { agent: string; task: string }[] } {
  const s = raw.trim();
  const candidates = [s, s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")];
  const first = s.indexOf("{"), last = s.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const o = JSON.parse(c) as { reply?: unknown; delegate?: unknown };
      const delegate = Array.isArray(o.delegate)
        ? o.delegate.filter((d): d is { agent: string; task: string } => !!d && typeof d === "object" && typeof (d as { agent?: unknown }).agent === "string").map((d) => ({ agent: String(d.agent).replace(/^@/, "").toLowerCase(), task: String((d as { task?: unknown }).task ?? "") }))
        : [];
      return { reply: typeof o.reply === "string" && o.reply.trim() ? o.reply.trim() : undefined, delegate };
    } catch { /* try next */ }
  }
  // Not JSON at all: treat the whole thing as the reply.
  return { reply: s, delegate: [] };
}
