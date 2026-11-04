import { bus } from "./events.js";
import type { Jarvis } from "./jarvis/orchestrator.js";
import { AGENTS, getAgent } from "./registry/index.js";
import { getAgentConfig } from "./config.js";

export interface Schedule {
  id: string;
  agentId: string;
  /** Task text sent to the agent, or "brief" for Jarvis's daily brief. */
  task: string;
  /** "every:<minutes>" or "daily@HH:MM" (server local time). */
  when: string;
  /** Phase in which this schedule becomes active. */
  phase: number;
}

/** Scouts and briefs on their timers. Nothing runs before its phase. */
export const SCHEDULES: Schedule[] = [
  { id: "daily-brief", agentId: "jarvis", task: "brief", when: process.env.BRIEF_AT ? `daily@${process.env.BRIEF_AT}` : "daily@07:00", phase: 0 },
  { id: "oscar-condense", agentId: "oscar", task: "condense", when: "daily@03:30", phase: 0 },
  { id: "oscar-inbox", agentId: "oscar", task: "Weekly inbox cleanup with Monica. For each of Phil's personal Google accounts: use gmail_senders on 'in:inbox older_than:14d' and 'category:promotions older_than:30d', then propose ONE archive plan per account as an approval (gmail.archive by query, with the match count in the body). Never trash. Keep anything from a real person or about money, travel, health or a job.", when: "weekly:sun@04:00", phase: 0 },
  { id: "monica-day", agentId: "monica", task: "Lay out Phil's day: what's on the calendar, what's unscheduled, what to protect.", when: "daily@06:45", phase: 1 },
  { id: "stella-leads", agentId: "stella", task: "Review new leads and open jobs for JD PM; flag anything waiting on a customer reply.", when: "daily@06:50", phase: 1 },
  { id: "mantis-markets", agentId: "mantis", task: "Market read for the day: what moved on-chain overnight and what the team should watch.", when: "daily@06:55", phase: 1 },
  { id: "ansem-scan", agentId: "ansem", task: "Hourly scan: new memecoins and low caps worth a look, with the reason each is on the list.", when: "every:60", phase: 2 },
  { id: "pentoshi-scan", agentId: "pentoshi", task: "Hourly scan: funding rates, perps positioning, prop-firm news.", when: "every:60", phase: 2 },
  { id: "marcus-open", agentId: "marcus", task: "Pre-market: tech and infra holdings, catalysts today, suggested changes for Buffett.", when: "daily@08:30", phase: 2 },
  { id: "house-open", agentId: "house", task: "Pre-market: biotech holdings, catalysts and approvals today, suggested changes for Buffett.", when: "daily@08:30", phase: 2 },
  { id: "exxon-open", agentId: "exxon", task: "Pre-market: energy holdings and catalysts today, suggested changes for Buffett.", when: "daily@08:30", phase: 2 },
  { id: "altman-open", agentId: "altman", task: "Pre-market: AI-era holdings and catalysts today, suggested changes for Buffett.", when: "daily@08:30", phase: 2 },
  { id: "armstrong-open", agentId: "armstrong", task: "Pre-market: crypto-niche stocks and catalysts today, suggested changes for Buffett.", when: "daily@08:30", phase: 2 },
  { id: "munger-weekly", agentId: "munger", task: "Weekly money summary: net worth, cash flow, deposits and withdrawals, and the holdings review from Buffett.", when: "daily@07:30", phase: 2 },
];

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private lastRun = new Map<string, number>();
  constructor(private jarvis: Jarvis, private schedules: Schedule[] = SCHEDULES) {}

  start(tickMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Phil's per-agent schedules from agent settings, merged over the built-in ones. */
  async allSchedules(): Promise<Schedule[]> {
    const custom: Schedule[] = [];
    for (const a of AGENTS) {
      const c = await getAgentConfig(this.jarvis.store, a.id);
      if (c.schedule?.enabled && c.schedule.when && c.schedule.task) custom.push({ id: `custom:${a.id}`, agentId: a.id, task: c.schedule.task, when: c.schedule.when, phase: 0 });
    }
    return [...this.schedules, ...custom];
  }

  /** Which schedules are due at `now`. Exposed for tests. */
  due(now: Date, phase: number, schedules: Schedule[] = this.schedules): Schedule[] {
    return schedules.filter((s) => {
      if (s.phase > phase) return false;
      const last = this.lastRun.get(s.id) ?? 0;
      if (s.when.startsWith("every:")) {
        const mins = Number(s.when.slice(6));
        if (!Number.isFinite(mins) || mins < 1) return false; // every:0 would run on every tick
        return now.getTime() - last >= mins * 60_000;
      }
      const wk = s.when.match(/^weekly:(sun|mon|tue|wed|thu|fri|sat)@(\d{2}):(\d{2})$/);
      if (wk && ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getDay()] !== wk[1]) return false;
      const m = s.when.match(/^(?:daily|weekly:[a-z]{3})@(\d{2}):(\d{2})$/);
      if (!m) return false;
      const target = new Date(now); target.setHours(Number(m[1]), Number(m[2]), 0, 0);
      const within = now.getTime() >= target.getTime() && now.getTime() - target.getTime() < 10 * 60_000;
      const ranToday = last >= target.getTime();
      return within && !ranToday;
    });
  }

  async tick(now = new Date()) {
    const phase = await this.jarvis.store.settings.get("phase", 0);
    for (const s of this.due(now, phase, await this.allSchedules())) {
      this.lastRun.set(s.id, now.getTime());
      const agent = getAgent(s.agentId);
      if (!agent) continue;
      await this.jarvis.router.log(agent.id, "schedule", `Scheduled: ${s.id}`);
      try {
        if (s.task === "brief") {
          const text = await this.jarvis.brief();
          await this.jarvis.say({ role: "jarvis", text: `Daily brief\n\n${text}` });
          bus.emitEvent({ type: "brief", text, at: new Date().toISOString() });
        } else if (s.task === "condense") {
          if ((await this.jarvis.store.memory.list()).length >= 20) await this.jarvis.say({ role: "system", text: await this.jarvis.condenseMemory() });
        } else {
          const r = await this.jarvis.runAgent(agent, s.task, { direct: false, from: "Scheduler" });
          if (!r.blocked) await this.jarvis.say({ role: "agent", agentId: agent.id, text: r.text, runId: r.runId });
        }
      } catch (e) {
        await this.jarvis.router.log(agent.id, "error", `Schedule ${s.id} failed: ${(e as Error).message}`);
      }
    }
    bus.emitEvent({ type: "system", status: await this.jarvis.systemStatus() });
  }
}
