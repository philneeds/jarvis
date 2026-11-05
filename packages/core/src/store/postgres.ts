import { and, desc, eq, gte, ilike, notInArray, or, sql } from "drizzle-orm";
import { createDb, type Db } from "../db/client.js";
import * as t from "../db/schema.js";
import type { ActivityEntry, Approval, ChatMessage } from "../events.js";
import type { AgentStateRow, MemoryItem, MetricPoint, RecordItem, RunRecord, Store, UsageRecord } from "./types.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const date = (s: string | undefined) => (s ? new Date(s) : undefined);

export function postgresStore(url = process.env.DATABASE_URL): Store {
  let db: Db;
  return {
    kind: "postgres",
    async init() {
      db = createDb(url);
      await db.execute(sql`select 1`);
    },
    async close() { /* postgres-js pool closes with the process */ },
    chat: {
      async add(m) {
        await db.insert(t.chatMessages).values({ id: m.id, at: new Date(m.at), role: m.role, agentId: m.agentId, text: m.text, runId: m.runId, via: m.via, channel: m.channel, replyTo: m.replyTo, kind: m.kind });
      },
      async list(limit = 100) {
        const rows = await db.select().from(t.chatMessages).orderBy(desc(t.chatMessages.at)).limit(limit);
        return rows.reverse().map((r) => ({ id: r.id, at: r.at.toISOString(), role: r.role as ChatMessage["role"], agentId: r.agentId ?? undefined, text: r.text, runId: r.runId ?? undefined, via: r.via ?? undefined, channel: (r.channel ?? undefined) as ChatMessage["channel"], replyTo: r.replyTo ?? undefined, kind: (r.kind ?? undefined) as ChatMessage["kind"] }));
      },
    },
    runs: {
      async add(r) {
        await db.insert(t.runs).values({ id: r.id, agentId: r.agentId, provider: r.provider, modelId: r.modelId, prompt: r.prompt, output: r.output, status: r.status, error: r.error, startedAt: new Date(r.startedAt), finishedAt: date(r.finishedAt), inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, parentRunId: r.parentRunId });
      },
      async update(id, p) {
        await db.update(t.runs).set({ provider: p.provider, modelId: p.modelId, output: p.output, status: p.status, error: p.error, finishedAt: date(p.finishedAt), inputTokens: p.inputTokens, outputTokens: p.outputTokens, costUsd: p.costUsd }).where(eq(t.runs.id, id));
      },
      async get(id) {
        const r = (await db.select().from(t.runs).where(eq(t.runs.id, id)))[0];
        return r ? { id: r.id, agentId: r.agentId, provider: r.provider ?? undefined, modelId: r.modelId ?? undefined, prompt: r.prompt, output: r.output ?? undefined, status: r.status as RunRecord["status"], error: r.error ?? undefined, startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt), inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, costUsd: r.costUsd ?? 0, parentRunId: r.parentRunId ?? undefined } : undefined;
      },
    },
    activity: {
      async add(e) {
        await db.insert(t.activityLog).values({ id: e.id, at: new Date(e.at), agentId: e.agentId, kind: e.kind, summary: e.summary, detail: e.detail, runId: e.runId });
      },
      async list({ q, agentId, limit = 200, exclude } = {}) {
        const conds = [];
        if (agentId) conds.push(eq(t.activityLog.agentId, agentId));
        if (exclude?.length) conds.push(notInArray(t.activityLog.kind, exclude));
        if (q) conds.push(or(ilike(t.activityLog.summary, `%${q}%`), ilike(t.activityLog.agentId, `%${q}%`), sql`${t.activityLog.detail}::text ilike ${"%" + q + "%"}`));
        const rows = await db.select().from(t.activityLog).where(conds.length ? and(...conds) : undefined).orderBy(desc(t.activityLog.at)).limit(limit);
        return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), agentId: r.agentId, kind: r.kind as ActivityEntry["kind"], summary: r.summary, detail: r.detail ?? undefined, runId: r.runId ?? undefined }));
      },
    },
    approvals: {
      async add(a) {
        await db.insert(t.approvals).values({ id: a.id, at: new Date(a.at), agentId: a.agentId, kind: a.kind, title: a.title, body: a.body, payload: a.payload, context: a.context, effect: a.effect, thread: a.thread, original: a.original, editedBy: a.editedBy, status: a.status, decidedAt: date(a.decidedAt), note: a.note, runId: a.runId });
      },
      async list(status) {
        const rows = await db.select().from(t.approvals).where(status ? eq(t.approvals.status, status) : undefined).orderBy(desc(t.approvals.at)).limit(500);
        return rows.map(toApproval);
      },
      async get(id) {
        const r = (await db.select().from(t.approvals).where(eq(t.approvals.id, id)))[0];
        return r ? toApproval(r) : undefined;
      },
      async update(id, p) {
        const rows = await db.update(t.approvals).set({ status: p.status, decidedAt: date(p.decidedAt), note: p.note, body: p.body, payload: p.payload, context: p.context, effect: p.effect, thread: p.thread, original: p.original, editedBy: p.editedBy }).where(eq(t.approvals.id, id)).returning();
        return rows[0] ? toApproval(rows[0]) : undefined;
      },
    },
    usage: {
      async add(u) {
        await db.insert(t.usage).values({ id: u.id, at: new Date(u.at), plan: u.plan, provider: u.provider, agentId: u.agentId, modelId: u.modelId, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, runId: u.runId });
      },
      async since(at) {
        const rows = await db.select().from(t.usage).where(gte(t.usage.at, at));
        return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), plan: r.plan, provider: r.provider, agentId: r.agentId, modelId: r.modelId ?? undefined, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, runId: r.runId ?? undefined }));
      },
    },
    memory: {
      async get(scope, key) {
        const r = (await db.select().from(t.memory).where(eq(t.memory.id, `${scope}:${key}`)))[0];
        return r ? toMemory(r) : undefined;
      },
      async set(item) {
        await db.insert(t.memory).values({ id: `${item.scope}:${item.key}`, scope: item.scope, key: item.key, value: item.value, source: item.source, updatedAt: new Date() })
          .onConflictDoUpdate({ target: t.memory.id, set: { value: item.value, source: item.source, updatedAt: new Date() } });
      },
      async list(scope) {
        const rows = await db.select().from(t.memory).where(scope ? eq(t.memory.scope, scope) : undefined).orderBy(desc(t.memory.updatedAt)).limit(1000);
        return rows.map(toMemory);
      },
      async remove(scope, key) { await db.delete(t.memory).where(eq(t.memory.id, `${scope}:${key}`)); },
    },
    agentState: {
      async get(id) {
        const r = (await db.select().from(t.agentState).where(eq(t.agentState.id, id)))[0];
        return r ? toState(r) : undefined;
      },
      async set(id, p) {
        const rows = await db.insert(t.agentState).values({ id, status: p.status ?? "idle", paused: p.paused ?? false, lastRunAt: date(p.lastRunAt), lastRunId: p.lastRunId, lastError: p.lastError, modelOverride: p.modelOverride, detail: p.detail })
          .onConflictDoUpdate({ target: t.agentState.id, set: { ...(p.status !== undefined && { status: p.status }), ...(p.paused !== undefined && { paused: p.paused }), ...(p.lastRunAt !== undefined && { lastRunAt: date(p.lastRunAt) }), ...(p.lastRunId !== undefined && { lastRunId: p.lastRunId }), ...(p.lastError !== undefined && { lastError: p.lastError }), ...(p.modelOverride !== undefined && { modelOverride: p.modelOverride }), ...(p.detail !== undefined && { detail: p.detail }) } })
          .returning();
        return toState(rows[0]!);
      },
      async all() { return (await db.select().from(t.agentState)).map(toState); },
    },
    settings: {
      async get(key, fallback) {
        const r = (await db.select().from(t.settings).where(eq(t.settings.key, key)))[0];
        return (r ? r.value : fallback) as typeof fallback;
      },
      async set(key, value) {
        await db.insert(t.settings).values({ key, value, updatedAt: new Date() }).onConflictDoUpdate({ target: t.settings.key, set: { value, updatedAt: new Date() } });
      },
    },
    metrics: {
      async add(m) { await db.insert(t.metrics).values({ id: m.id, venture: m.venture, key: m.key, at: new Date(m.at), value: m.value, source: m.source }); },
      async series(venture, key, limit = 60) {
        const rows = await db.select().from(t.metrics).where(and(eq(t.metrics.venture, venture), eq(t.metrics.key, key))).orderBy(desc(t.metrics.at)).limit(limit);
        return rows.reverse().map(toMetric);
      },
      async latest(venture) {
        const rows = await db.select().from(t.metrics).where(eq(t.metrics.venture, venture)).orderBy(desc(t.metrics.at)).limit(2000);
        const out = new Map<string, MetricPoint>();
        for (const r of rows) if (!out.has(r.key)) out.set(r.key, toMetric(r));
        return [...out.values()];
      },
      async get(id) { const r = (await db.select().from(t.metrics).where(eq(t.metrics.id, id)))[0]; return r ? toMetric(r) : undefined; },
      async update(id, p) { const rows = await db.update(t.metrics).set({ value: p.value }).where(eq(t.metrics.id, id)).returning(); return rows[0] ? toMetric(rows[0]) : undefined; },
      async remove(id) { await db.delete(t.metrics).where(eq(t.metrics.id, id)); },
    },
    records: {
      async upsert(r) {
        await db.insert(t.records).values({ id: r.id, venture: r.venture, kind: r.kind, title: r.title, status: r.status, fields: r.fields, source: r.source, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) })
          .onConflictDoUpdate({ target: t.records.id, set: { title: r.title, status: r.status, fields: r.fields, source: r.source, updatedAt: new Date(r.updatedAt) } });
      },
      async list(venture, kind) {
        const rows = await db.select().from(t.records).where(kind ? and(eq(t.records.venture, venture), eq(t.records.kind, kind)) : eq(t.records.venture, venture)).orderBy(desc(t.records.updatedAt)).limit(1000);
        return rows.map(toRecord);
      },
      async get(id) { const r = (await db.select().from(t.records).where(eq(t.records.id, id)))[0]; return r ? toRecord(r) : undefined; },
      async remove(id) { await db.delete(t.records).where(eq(t.records.id, id)); },
    },
  };
}

const toMetric = (r: typeof t.metrics.$inferSelect): MetricPoint => ({ id: r.id, venture: r.venture, key: r.key, at: r.at.toISOString(), value: r.value, source: r.source ?? undefined });
const toRecord = (r: typeof t.records.$inferSelect): RecordItem => ({ id: r.id, venture: r.venture, kind: r.kind, title: r.title, status: r.status, fields: r.fields ?? {}, source: r.source ?? undefined, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });

const toApproval = (r: typeof t.approvals.$inferSelect): Approval => ({ id: r.id, at: r.at.toISOString(), agentId: r.agentId, kind: r.kind as Approval["kind"], title: r.title, body: r.body, payload: r.payload ?? undefined, context: r.context ?? undefined, effect: r.effect ?? undefined, thread: r.thread ?? undefined, original: r.original ?? undefined, editedBy: (r.editedBy ?? undefined) as Approval["editedBy"], status: r.status as Approval["status"], decidedAt: iso(r.decidedAt), note: r.note ?? undefined, runId: r.runId ?? undefined });
const toMemory = (r: typeof t.memory.$inferSelect): MemoryItem => ({ scope: r.scope, key: r.key, value: r.value, source: r.source ?? undefined, updatedAt: r.updatedAt.toISOString() });
const toState = (r: typeof t.agentState.$inferSelect): AgentStateRow => ({ id: r.id, status: r.status, paused: r.paused, lastRunAt: iso(r.lastRunAt), lastRunId: r.lastRunId ?? undefined, lastError: r.lastError ?? undefined, modelOverride: r.modelOverride ?? undefined, detail: r.detail ?? undefined });
