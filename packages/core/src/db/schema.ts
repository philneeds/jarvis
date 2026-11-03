import { pgTable, text, timestamp, integer, jsonb, boolean, real, index } from "drizzle-orm/pg-core";

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  role: text("role").notNull(),
  agentId: text("agent_id"),
  text: text("text").notNull(),
  runId: text("run_id"),
  via: jsonb("via").$type<string[]>(),
}, (t) => [index("chat_at_idx").on(t.at)]);

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  provider: text("provider"),
  modelId: text("model_id"),
  prompt: text("prompt").notNull(),
  output: text("output"),
  status: text("status").notNull(), // running | done | error | blocked
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  costUsd: real("cost_usd").default(0),
  parentRunId: text("parent_run_id"),
});

export const activityLog = pgTable("activity_log", {
  id: text("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  runId: text("run_id"),
}, (t) => [index("activity_at_idx").on(t.at), index("activity_agent_idx").on(t.agentId)]);

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  note: text("note"),
  runId: text("run_id"),
}, (t) => [index("approvals_status_idx").on(t.status)]);

export const usage = pgTable("usage", {
  id: text("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  plan: text("plan").notNull(),
  provider: text("provider").notNull(),
  agentId: text("agent_id").notNull(),
  modelId: text("model_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  runId: text("run_id"),
}, (t) => [index("usage_at_idx").on(t.at)]);

export const memory = pgTable("memory", {
  id: text("id").primaryKey(), // `${scope}:${key}`
  scope: text("scope").notNull(), // phil | venture:<id> | agent:<id> | contact:<name>
  key: text("key").notNull(),
  value: text("value").notNull(),
  source: text("source"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("memory_scope_idx").on(t.scope)]);

export const agentState = pgTable("agent_state", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("idle"),
  paused: boolean("paused").notNull().default(false),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastRunId: text("last_run_id"),
  lastError: text("last_error"),
  modelOverride: text("model_override"),
  detail: text("detail"),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const metrics = pgTable("metrics", {
  id: text("id").primaryKey(),
  venture: text("venture").notNull(),
  key: text("key").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  value: real("value").notNull(),
  source: text("source"),
}, (t) => [index("metrics_vk_idx").on(t.venture, t.key, t.at)]);

export const records = pgTable("records", {
  id: text("id").primaryKey(),
  venture: text("venture").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  fields: jsonb("fields").$type<Record<string, unknown>>(),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("records_vk_idx").on(t.venture, t.kind)]);
