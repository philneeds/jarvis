import type { Store } from "./store/types.js";
import type { ChatMessage } from "./events.js";
import { SHIP_KEY, Workshop, type ShipRecord } from "./workshop.js";

/**
 * While an approved update is waiting to restart HQ, nothing new starts in the background, so the update goes in as
 * soon as the runs that were already going finish. Before this, the wait counted work that began after the approval:
 * a job queued for Einstein's workshop started the moment his current one ended, and routines and watchers kept
 * firing (Nov 20: an update sat 22+ minutes behind a 31-minute job with another queued behind it).
 *   - routines and watchers don't start; they are left due and run on the first tick after the update
 *   - a job for Einstein's workshop is held and kept in the store (HELD_JOBS_KEY), and starts after the restart
 *   - what Phil asks for himself still runs, and a run in progress is never cut off (the deploy waits for it)
 * The hold ends with the ship record: when HQ is back and has read the deploy's verdict. If the deploy never restarts
 * HQ, it ends on its own DEPLOY_HOLD_MS after the approval, so a stuck record can't stop the routines for good.
 */
export const DEPLOY_HOLD_MS = Workshop.WAIT_FOR_RUNS_MS + 25 * 60_000;

/** The update that is waiting to restart HQ, if there is one. */
export async function deployPending(store: Store, now = Date.now()): Promise<ShipRecord | undefined> {
  const rec = await store.settings.get<ShipRecord | null>(SHIP_KEY, null);
  if (!rec || rec.status !== "shipping") return undefined;
  const age = now - Date.parse(rec.at);
  return Number.isFinite(age) && age < DEPLOY_HOLD_MS ? rec : undefined;
}

export const HELD_JOBS_KEY = "workshop.heldJobs";
/**
 * A job for the workshop that hasn't started: held for an update ("update"), or waiting behind the job in the
 * workshop ("queued"). Kept in the store so a restart doesn't lose it.
 */
export interface HeldJob {
  id: string;
  agentId: string;
  task: string;
  /** Who asked, as the run was told ("Phil", "Jarvis", another agent's name). */
  from?: string;
  /** Asked by Phil himself (not background work), so it runs past the usage caps as it would have. */
  direct?: boolean;
  /** When it was asked. */
  at: string;
  why: "update" | "queued";
  /** The conversation it was asked in, so the answer goes back there (Telegram, a reply in HQ). */
  convo?: { channel: ChatMessage["channel"]; replyTo: string };
}

/** The jobs waiting for the workshop, oldest first, and which of them this process is still waiting on. */
export class HeldJobs {
  /** Jobs something in this process is waiting on or running; the rest were left by a restart or held for an update. */
  private live = new Set<string>();
  /** The list is read-modify-write, so changes to it run one at a time. */
  private lock: Promise<unknown> = Promise.resolve();
  constructor(private store: Store) {}

  private change<T>(fn: (jobs: HeldJob[]) => Promise<T>): Promise<T> {
    const p = this.lock.then(async () => fn(await this.list()));
    this.lock = p.catch(() => undefined);
    return p;
  }
  async list(): Promise<HeldJob[]> { return this.store.settings.get<HeldJob[]>(HELD_JOBS_KEY, []); }

  /**
   * Keep a job that can't start yet. `waiting` says a run in this process is still waiting on it (queued behind the
   * job in the workshop); without it the job is only on the list, for resume() to start. A job already on the list
   * keeps its place and the time it was asked. Returns what the list said about it before.
   */
  keep(job: HeldJob, waiting: boolean): Promise<HeldJob | undefined> {
    if (waiting) this.live.add(job.id); else this.live.delete(job.id);
    return this.change(async (jobs) => {
      const was = jobs.find((j) => j.id === job.id);
      await this.store.settings.set(HELD_JOBS_KEY, was ? jobs.map((j) => (j.id === job.id ? { ...job, at: was.at } : j)) : [...jobs, job]);
      return was;
    });
  }
  /** The job got the workshop (or ran without it): off the list. */
  drop(id: string): Promise<void> {
    this.live.delete(id);
    return this.change(async (jobs) => { if (jobs.some((j) => j.id === id)) await this.store.settings.set(HELD_JOBS_KEY, jobs.filter((j) => j.id !== id)); });
  }
  /** The jobs nothing in this process is waiting on, oldest first, taken by the caller to start now. */
  take(): Promise<HeldJob[]> {
    return this.change(async (all) => {
      const jobs = all.filter((j) => !this.live.has(j.id)).sort((a, b) => a.at.localeCompare(b.at));
      for (const j of jobs) this.live.add(j.id);
      return jobs;
    });
  }
  /** Give back jobs that were taken but not started (an update came in first); they stay on the list. */
  giveBack(ids: string[]) { for (const id of ids) this.live.delete(id); }
}

/** The chat line for a job that is held: what, and when it starts. */
export function heldLine(agentName: string, task: string): string {
  const t = task.replace(/\s+/g, " ").trim();
  return `${agentName}'s job is held, not started: "${t.length > 140 ? `${t.slice(0, 140)}…` : t}". An HQ update is waiting to go in and a new code job would hold it up; the job is saved and starts right after the update.`;
}
