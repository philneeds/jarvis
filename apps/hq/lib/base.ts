"use client";

import { useCallback, useEffect, useState } from "react";
import type { BaseSummary, Goal, Horizon } from "@jarvis/core";
import { api, post } from "./api";
import { useLive } from "./live";

export type { BaseSummary, Horizon };

/** Trophies, each venture's level, today's three and the streak. Fetched again whenever something they depend on changes. */
export function useBase() {
  const { onEvent } = useLive();
  const [base, setBase] = useState<BaseSummary | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const reload = useCallback(() => api<BaseSummary>("/api/base").then(setBase).catch(() => undefined), []);
  const reloadGoals = useCallback(() => api<{ goals: Goal[] }>("/api/goals").then((r) => setGoals(r.goals)).catch(() => undefined), []);
  useEffect(() => { void reload(); void reloadGoals(); }, [reload, reloadGoals]);
  useEffect(() => onEvent((e) => { if (e.type === "goals") setGoals(e.goals); }), [onEvent]);
  // A decided approval, a ticked to-do or a met benchmark can each tick one of today's three.
  useEffect(() => onEvent((e) => { if (e.type === "base" || e.type === "goals" || e.type === "approval.decided" || e.type === "attention") void reload(); }), [onEvent, reload]);
  const toggle = useCallback((id: string) => post<BaseSummary>(`/api/today/${encodeURIComponent(id)}/toggle`).then(setBase).catch(() => undefined), []);
  const repick = useCallback(() => post<BaseSummary>("/api/today/repick").then(setBase).catch(() => undefined), []);
  return { base, goals, setGoals, reload, toggle, repick };
}

export const HORIZONS: Horizon[] = ["long", "mid", "short"];
export const HORIZON_LABEL: Record<Horizon, string> = { long: "Long term", mid: "Mid term", short: "Short term" };
export const HORIZON_HINT: Record<Horizon, string> = { long: "1 to 3 years", mid: "this quarter", short: "the next two weeks" };

/** The same rule the server uses (packages/core/src/progress.ts): what Phil set, else read off the deadline. */
export function horizonOf(g: Pick<Goal, "horizon" | "deadline">, now = Date.now()): Horizon {
  if (g.horizon) return g.horizon;
  if (!g.deadline) return "long";
  const days = (Date.parse(`${g.deadline}T12:00:00Z`) - now) / 86_400_000;
  return days <= 14 ? "short" : days <= 120 ? "mid" : "long";
}

export const LEVEL_NAME = ["", "Outpost", "Office", "Branch", "Headquarters", "Landmark"];
