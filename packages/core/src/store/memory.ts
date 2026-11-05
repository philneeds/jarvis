import fs from "node:fs";
import path from "node:path";
import type { ActivityEntry, Approval, ChatMessage } from "../events.js";
import type { AgentStateRow, MemoryItem, MetricPoint, RecordItem, RunRecord, Store, UsageRecord } from "./types.js";

interface Snapshot {
  chat: ChatMessage[];
  runs: RunRecord[];
  activity: ActivityEntry[];
  approvals: Approval[];
  usage: UsageRecord[];
  memory: MemoryItem[];
  agentState: AgentStateRow[];
  settings: Record<string, unknown>;
  metrics: MetricPoint[];
  records: RecordItem[];
}

/**
 * In-memory store with optional JSON persistence (JARVIS_DATA_FILE). Good for development and tests;
 * Postgres is the real thing.
 */
export function memoryStore(file?: string): Store {
  const s: Snapshot = { chat: [], runs: [], activity: [], approvals: [], usage: [], memory: [], agentState: [], settings: {}, metrics: [], records: [] };
  let saveTimer: NodeJS.Timeout | undefined;
  const save = () => {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(s));
    }, 200);
  };
  const byAtDesc = <T extends { at: string }>(a: T, b: T) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  return {
    kind: "memory",
    async init() {
      if (file && fs.existsSync(file)) {
        try { Object.assign(s, JSON.parse(fs.readFileSync(file, "utf8"))); } catch { /* start fresh */ }
        s.metrics ??= []; s.records ??= [];
      }
    },
    async close() { clearTimeout(saveTimer); if (file) fs.writeFileSync(file, JSON.stringify(s)); },
    chat: {
      async add(m) { s.chat.push(m); if (s.chat.length > 5000) s.chat.splice(0, s.chat.length - 5000); save(); },
      async list(limit = 100) { return s.chat.slice(-limit); },
    },
    runs: {
      async add(r) { s.runs.push(r); if (s.runs.length > 5000) s.runs.splice(0, s.runs.length - 5000); save(); },
      async update(id, patch) { const r = s.runs.find((x) => x.id === id); if (r) Object.assign(r, patch); save(); },
      async get(id) { return s.runs.find((x) => x.id === id); },
    },
    activity: {
      async add(e) { s.activity.push(e); if (s.activity.length > 20000) s.activity.splice(0, s.activity.length - 20000); save(); },
      async list({ q, agentId, limit = 200, exclude } = {}) {
        const ql = q?.toLowerCase();
        return s.activity
          .filter((e) => (!agentId || e.agentId === agentId) && !exclude?.includes(e.kind) && (!ql || e.summary.toLowerCase().includes(ql) || e.agentId.includes(ql) || JSON.stringify(e.detail ?? {}).toLowerCase().includes(ql)))
          .sort(byAtDesc)
          .slice(0, limit);
      },
      async countSince(kind, since) {
        const from = since.toISOString(), out: Record<string, number> = {};
        for (const e of s.activity) if (e.kind === kind && e.at >= from) out[e.agentId] = (out[e.agentId] ?? 0) + 1;
        return out;
      },
    },
    approvals: {
      async add(a) { s.approvals.push(a); save(); },
      async list(status) { return s.approvals.filter((a) => !status || a.status === status).sort(byAtDesc); },
      async get(id) { return s.approvals.find((a) => a.id === id); },
      async update(id, patch) { const a = s.approvals.find((x) => x.id === id); if (a) Object.assign(a, patch); save(); return a; },
    },
    usage: {
      async add(u) { s.usage.push(u); if (s.usage.length > 50000) s.usage.splice(0, s.usage.length - 50000); save(); },
      async since(at) { const iso = at.toISOString(); return s.usage.filter((u) => u.at >= iso); },
    },
    memory: {
      async get(scope, key) { return s.memory.find((m) => m.scope === scope && m.key === key); },
      async set(item) {
        const i = s.memory.findIndex((m) => m.scope === item.scope && m.key === item.key);
        const row = { ...item, updatedAt: new Date().toISOString() };
        if (i >= 0) s.memory[i] = row; else s.memory.push(row);
        save();
      },
      async list(scope) { return s.memory.filter((m) => !scope || m.scope === scope); },
      async remove(scope, key) { const i = s.memory.findIndex((m) => m.scope === scope && m.key === key); if (i >= 0) s.memory.splice(i, 1); save(); },
    },
    agentState: {
      async get(id) { return s.agentState.find((a) => a.id === id); },
      async set(id, patch) {
        let a = s.agentState.find((x) => x.id === id);
        if (!a) { a = { id, status: "idle", paused: false }; s.agentState.push(a); }
        Object.assign(a, patch);
        save();
        return a;
      },
      async all() { return s.agentState; },
    },
    settings: {
      async get(key, fallback) { return (key in s.settings ? s.settings[key] : fallback) as typeof fallback; },
      async set(key, value) { s.settings[key] = value; save(); },
    },
    metrics: {
      async add(m) { s.metrics.push(m); if (s.metrics.length > 100000) s.metrics.splice(0, s.metrics.length - 100000); save(); },
      async series(venture, key, limit = 60) { return s.metrics.filter((m) => m.venture === venture && m.key === key).sort((a, b) => (a.at < b.at ? -1 : 1)).slice(-limit); },
      async latest(venture) {
        const out = new Map<string, MetricPoint>();
        for (const m of s.metrics.filter((x) => x.venture === venture).sort((a, b) => (a.at < b.at ? -1 : 1))) out.set(m.key, m);
        return [...out.values()];
      },
      async get(id) { return s.metrics.find((m) => m.id === id); },
      async update(id, patch) { const m = s.metrics.find((x) => x.id === id); if (!m) return undefined; m.value = patch.value; save(); return m; },
      async remove(id) { const i = s.metrics.findIndex((m) => m.id === id); if (i >= 0) s.metrics.splice(i, 1); save(); },
    },
    records: {
      async upsert(r) { const i = s.records.findIndex((x) => x.id === r.id); if (i >= 0) s.records[i] = r; else s.records.push(r); save(); },
      async list(venture, kind) { return s.records.filter((r) => r.venture === venture && (!kind || r.kind === kind)).sort(byAtDesc2); },
      async get(id) { return s.records.find((r) => r.id === id); },
      async remove(id) { const i = s.records.findIndex((r) => r.id === id); if (i >= 0) s.records.splice(i, 1); save(); },
    },
  };
}

const byAtDesc2 = (a: { updatedAt: string }, b: { updatedAt: string }) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
