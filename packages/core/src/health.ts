import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store/types.js";
import { defineTool, type ToolDef } from "./tools/index.js";

/**
 * Phil's Apple Health data for Doc. The iPhone app Health Auto Export posts its JSON to
 * POST /api/apple-health/ingest with "Authorization: Bearer <key>"; the key is made in HQ Settings, so no secret is
 * ever typed into the server. Each sample is folded into one record per day and metric; any metric the app sends is
 * kept, so adding one in the app is all it takes. 120 days are kept.
 */
const DAYS_KEY = "health.days";
const KEY_KEY = "health.key";
const LAST_KEY = "health.lastIngest";
const KEEP_DAYS = 120;

/** Metrics that add up over a day; everything else is averaged (heart rate, HRV) or, for body measures, the last one wins. */
const SUM = /^(step_count|active_energy|basal_energy_burned|apple_exercise_time|apple_stand_time|flights_climbed|walking_running_distance|cycling_distance|swimming_distance|dietary_|water|mindful_minutes|time_in_daylight)/;
const LAST = /^(weight_body_mass|body_mass_index|body_fat_percentage|lean_body_mass|height|waist_circumference|vo2_max)/;

export interface DayMetric { units?: string; sum: number; n: number; last: number }
export interface DaySleep { hours: number; deep?: number; rem?: number; core?: number; awake?: number; start?: string; end?: string }
export interface DayWorkout { name: string; minutes: number; kcal?: number; km?: number }
export interface HealthDay { metrics: Record<string, DayMetric>; sleep?: DaySleep; workouts: DayWorkout[] }
type Days = Record<string, HealthDay>;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const qty = (v: unknown): number | undefined => (v && typeof v === "object" ? num((v as { qty?: unknown }).qty) : num(v));
/** "2026-11-05 07:12:00 -0500" or ISO → "2026-11-05" (the day as the phone saw it). */
const dayOf = (d: unknown): string | undefined => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : undefined);

const payloadSchema = z.object({
  data: z.object({
    metrics: z.array(z.object({ name: z.string(), units: z.string().optional(), data: z.array(z.record(z.string(), z.unknown())).default([]) })).optional(),
    workouts: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
});

/** Fold one Health Auto Export payload into the stored days. Returns how many samples and workouts were taken. */
export async function ingestHealth(store: Store, body: unknown, now = new Date()): Promise<{ samples: number; workouts: number; days: string[] }> {
  const p = payloadSchema.safeParse(body);
  if (!p.success) throw new Error("not a Health Auto Export payload (expected { data: { metrics, workouts } })");
  const days = await store.settings.get<Days>(DAYS_KEY, {});
  const day = (d: string) => (days[d] ??= { metrics: {}, workouts: [] });
  let samples = 0, workouts = 0;
  const touched = new Set<string>();
  // The app resends a window of days: the first time a day/metric pair appears in this payload it replaces what was
  // stored, later samples in the same payload add to it. So a resend never double-counts.
  const seen = new Set<string>();

  for (const m of p.data.data.metrics ?? []) {
    const name = m.name.toLowerCase();
    for (const s of m.data) {
      const d = dayOf(s.date ?? s.sleepEnd ?? s.endDate);
      if (!d) continue;
      if (name === "sleep_analysis") {
        // Sleep is attributed to the day it ends (the morning Phil wakes up).
        const hours = num(s.totalSleep) ?? num(s.asleep) ?? num(s.qty);
        if (hours === undefined) continue;
        const end = dayOf(s.sleepEnd) ?? d;
        day(end).sleep = { hours, deep: num(s.deep), rem: num(s.rem), core: num(s.core), awake: num(s.awake), start: typeof s.sleepStart === "string" ? s.sleepStart : undefined, end: typeof s.sleepEnd === "string" ? s.sleepEnd : undefined };
        touched.add(end); samples++;
        continue;
      }
      const v = num(s.qty) ?? num(s.Avg) ?? num(s.avg);
      if (v === undefined) continue;
      const key = `${d}|${name}`;
      if (!seen.has(key)) { seen.add(key); day(d).metrics[name] = { units: m.units, sum: 0, n: 0, last: v }; }
      const mm = day(d).metrics[name]!;
      mm.sum += v; mm.n += 1; mm.last = v;
      touched.add(d); samples++;
    }
  }
  const seenWorkoutDays = new Set<string>();
  for (const w of p.data.data.workouts ?? []) {
    const d = dayOf(w.start ?? w.startDate);
    if (!d) continue;
    if (!seenWorkoutDays.has(d)) { seenWorkoutDays.add(d); day(d).workouts = []; }
    const secs = num(w.duration);
    day(d).workouts.push({ name: String(w.name ?? "Workout"), minutes: Math.round((secs ?? 0) / 60), kcal: qty(w.activeEnergyBurned) ?? qty(w.activeEnergy), km: qty(w.distance) });
    touched.add(d); workouts++;
  }
  // Keep the last KEEP_DAYS days.
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
  await store.settings.set(DAYS_KEY, days);
  await store.settings.set(LAST_KEY, { at: now.toISOString(), samples, workouts });
  return { samples, workouts, days: [...touched].sort() };
}

/** One day's value for a metric: a total for things that add up, the last reading for body measures, else the average. */
export function metricValue(name: string, m: DayMetric): number {
  return SUM.test(name) ? m.sum : LAST.test(name) ? m.last : m.sum / Math.max(1, m.n);
}

const LABEL: Record<string, string> = { step_count: "steps", active_energy: "active kcal", apple_exercise_time: "exercise min", resting_heart_rate: "resting HR", heart_rate_variability: "HRV ms", heart_rate: "avg HR", weight_body_mass: "weight", walking_running_distance: "walk/run dist", flights_climbed: "flights", vo2_max: "VO2 max" };
const ORDER = ["step_count", "active_energy", "apple_exercise_time", "resting_heart_rate", "heart_rate_variability", "weight_body_mass"];

export async function healthSummary(store: Store, days = 7, now = new Date()): Promise<string> {
  const all = await store.settings.get<Days>(DAYS_KEY, {});
  const last = await store.settings.get<{ at: string } | null>(LAST_KEY, null);
  const keys = Object.keys(all).sort().reverse().slice(0, days);
  if (!keys.length) return "No health data yet. Phil connects Apple Health in HQ Settings (Health Auto Export app).";
  // Big counts as whole numbers (9,200 steps); smaller values keep one decimal where they have one (180.6 lb, 7.5 km).
  const fmt = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(1).replace(/\.0$/, ""));
  const lines = keys.map((d) => {
    const day = all[d]!;
    const parts: string[] = [];
    if (day.sleep) parts.push(`sleep ${day.sleep.hours.toFixed(1)} h${day.sleep.deep !== undefined ? ` (deep ${day.sleep.deep.toFixed(1)}, REM ${(day.sleep.rem ?? 0).toFixed(1)})` : ""}`);
    const names = [...ORDER.filter((n) => day.metrics[n]), ...Object.keys(day.metrics).filter((n) => !ORDER.includes(n)).sort()];
    for (const n of names) parts.push(`${LABEL[n] ?? n.replace(/_/g, " ")} ${fmt(metricValue(n, day.metrics[n]!))}${n === "weight_body_mass" && day.metrics[n]!.units ? ` ${day.metrics[n]!.units}` : ""}`);
    if (day.workouts.length) parts.push(`workouts: ${day.workouts.map((w) => `${w.name} ${w.minutes} min${w.kcal ? ` ${Math.round(w.kcal)} kcal` : ""}`).join(", ")}`);
    return `${d}: ${parts.join(" · ") || "no readings"}`;
  });
  const age = last ? Math.round((now.getTime() - Date.parse(last.at)) / 3_600_000) : undefined;
  return `${lines.join("\n")}${age !== undefined ? `\n(last sync ${age < 1 ? "under an hour" : `${age} h`} ago)` : ""}`;
}

/** The key Health Auto Export sends; made once in Settings. */
export async function healthKey(store: Store, create = false): Promise<string | undefined> {
  let k = await store.settings.get<string | null>(KEY_KEY, null);
  if (!k && create) { k = randomBytes(24).toString("base64url"); await store.settings.set(KEY_KEY, k); }
  return k ?? undefined;
}
export async function rotateHealthKey(store: Store): Promise<string> { const k = randomBytes(24).toString("base64url"); await store.settings.set(KEY_KEY, k); return k; }
export async function healthKeyOk(store: Store, given: string | undefined): Promise<boolean> {
  const k = await healthKey(store);
  if (!k || !given) return false;
  const a = Buffer.from(k), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function healthStatus(store: Store) {
  const last = await store.settings.get<{ at: string; samples: number; workouts: number } | null>(LAST_KEY, null);
  const days = Object.keys(await store.settings.get<Days>(DAYS_KEY, {}));
  return { keySet: !!(await healthKey(store)), lastIngest: last, days: days.length };
}

export const HEALTH_TOOLS: ToolDef[] = [
  defineTool({
    name: "health_summary",
    description: "Phil's Apple Health data, one line per day, newest first: sleep, steps, active energy, exercise, heart rate, HRV, weight, workouts, and anything else his phone sends.",
    schema: { days: z.number().int().min(1).max(30).optional() },
    handler: async ({ days }, { store }) => healthSummary(store, days ?? 7),
  }),
];
