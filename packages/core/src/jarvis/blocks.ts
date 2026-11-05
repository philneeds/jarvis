import type { ApprovalKind } from "../events.js";

export interface ApprovalBlock { kind: ApprovalKind; title: string; body: string; payload?: Record<string, unknown>; context?: string }
export interface RememberBlock { scope: string; key: string; value: string }
export interface MetricBlock { venture: string; key: string; value: number; at?: string }
export interface RecordBlock { venture: string; kind: string; id?: string; title: string; status?: string; fields?: Record<string, unknown> }
export interface HandoffBlock { agent: string; task: string }
export interface AttentionBlock { title: string; why: string; due?: string; venture?: string }

const KINDS: ApprovalKind[] = ["send", "post", "money", "strategy", "config", "record", "other"];

/** Pull fenced ```approval and ```remember JSON blocks out of an agent's reply. */
export function extractBlocks(text: string): { text: string; approvals: ApprovalBlock[]; remember: RememberBlock[]; metrics: MetricBlock[]; records: RecordBlock[]; handoffs: HandoffBlock[]; attention: AttentionBlock[] } {
  const approvals: ApprovalBlock[] = [];
  const remember: RememberBlock[] = [];
  const metrics: MetricBlock[] = [];
  const records: RecordBlock[] = [];
  const handoffs: HandoffBlock[] = [];
  const attention: AttentionBlock[] = [];
  const re = /```(approval|remember|metric|record|handoff|attention)\s*\n([\s\S]*?)```/g;
  const cleaned = text.replace(re, (_m, tag: string, body: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(body.trim()); } catch { return _m; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (tag === "approval") {
      for (const it of items) {
        const o = it as Partial<ApprovalBlock>;
        if (!o || typeof o !== "object" || !o.title) continue;
        approvals.push({ kind: KINDS.includes(o.kind as ApprovalKind) ? (o.kind as ApprovalKind) : "other", title: String(o.title), body: String(o.body ?? ""), payload: o.payload && typeof o.payload === "object" ? (o.payload as Record<string, unknown>) : undefined, context: o.context ? String(o.context) : undefined });
      }
      return approvals.length ? `[Approval queued: ${approvals[approvals.length - 1]!.title}]` : _m;
    }
    if (tag === "attention") {
      for (const it of items) {
        const o = it as Partial<AttentionBlock>;
        if (!o || typeof o !== "object" || !o.title) continue;
        attention.push({ title: String(o.title).slice(0, 160), why: String(o.why ?? "").slice(0, 600), due: o.due ? String(o.due) : undefined, venture: o.venture ? String(o.venture) : undefined });
      }
      return attention.length ? `[Needs you: ${attention.map((a) => a.title).join("; ")}]` : _m;
    }
    if (tag === "handoff") {
      for (const it of items) {
        const o = it as Partial<HandoffBlock>;
        if (!o || typeof o !== "object" || !o.agent || !o.task) continue;
        handoffs.push({ agent: String(o.agent).replace(/^@/, "").toLowerCase(), task: String(o.task) });
      }
      return handoffs.length ? `[Handed to ${handoffs.map((h) => "@" + h.agent).join(", ")}]` : _m;
    }
    if (tag === "metric") {
      for (const it of items) {
        const o = it as Partial<MetricBlock>;
        if (!o || typeof o !== "object" || !o.venture || !o.key || typeof o.value !== "number" || !Number.isFinite(o.value)) continue;
        metrics.push({ venture: String(o.venture), key: String(o.key), value: o.value, at: o.at ? String(o.at) : undefined });
      }
      return "";
    }
    if (tag === "record") {
      for (const it of items) {
        const o = it as Partial<RecordBlock>;
        if (!o || typeof o !== "object" || !o.venture || !o.kind || !o.title) continue;
        records.push({ venture: String(o.venture), kind: String(o.kind), id: o.id ? String(o.id) : undefined, title: String(o.title), status: o.status ? String(o.status) : undefined, fields: o.fields && typeof o.fields === "object" ? (o.fields as Record<string, unknown>) : undefined });
      }
      return "";
    }
    for (const it of items) {
      const o = it as Partial<RememberBlock>;
      if (!o || typeof o !== "object" || !o.key || o.value === undefined) continue;
      remember.push({ scope: String(o.scope ?? "phil"), key: String(o.key), value: String(o.value) });
    }
    return "";
  });
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), approvals, remember, metrics, records, handoffs, attention };
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
