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
  /** Also send the result to Phil's phone (Telegram) as a report. */
  push?: boolean;
}

/** Scouts and briefs on their timers. Nothing runs before its phase. */
export const SCHEDULES: Schedule[] = [
  { id: "daily-brief", agentId: "jarvis", task: "brief", when: process.env.BRIEF_AT ? `daily@${process.env.BRIEF_AT}` : "daily@07:00", phase: 0 },
  { id: "oscar-condense", agentId: "oscar", task: "condense", when: "daily@03:30", phase: 0 },
  { id: "einstein-weekly", agentId: "einstein", task: "Weekly review for Phil, short enough to read on his phone. Call web_health for the last 7 days. Then: the three changes you'd make this week and why (errors to fix, slow or idle agents, usage, approvals Phil keeps rejecting); where each of Phil's ideas on your list stands; anything to cut, for Oscar. Put each change you want made as an approval (kind config) so Phil can say yes or no.", when: "weekly:sun@19:00", phase: 0, push: true },
  { id: "adam-monthly", agentId: "adam", task: "Monthly goals session with Phil. Call goals_list for where his current goals stand, and look at each venture's board. Then: one line on how last month went against each goal; then propose this month's goals (one primary, up to two more), each specific and measurable with a deadline, and why each matters now. Put the proposal in one approval with payload {\"action\":\"goals.set\",\"add\":[{\"name\":\"...\",\"deadline\":\"YYYY-MM-DD\",\"primary\":true}],\"retire\":[\"<id of a goal that is done or dropped>\"]}. Phil will question or change it on the card before approving.", when: "monthly:1@08:00", phase: 0, push: true },
  { id: "buffett-weekly", agentId: "buffett", task: "Weekly holdings review after Friday's close, short enough to read on a phone. Read the holdings (kubera_items; everything is at Robinhood). Say how each did this week, what the scouts flagged, and at most three suggested changes, each as an approval with the reason. Then keep the scouts informed: a remember block with scope venture:money and key holdings listing the tickers by sector. And add any stock Phil talked about this week (chat_recent) to the watchlist as a record with status watch.", when: "weekly:fri@16:45", phase: 2, push: true },
  { id: "david-weekly", agentId: "david", task: "Weekly goals check: call goals_list; for each goal say where it stands, what moved this week, and the one or two steps that matter next week. Flag any goal that's slipping. Where the evidence clearly shows progress (for example jobs closed on the JD PM board), update the goal's percent with a goals.update approval block and say what you changed.", when: "weekly:sun@18:00", phase: 0, push: true },
  { id: "karol-leads", agentId: "karol", task: "Morning lead check for JD PM: new leads since yesterday, each logged on the board, and a first reply drafted for every one that hasn't had one.", when: "daily@07:15", phase: 1 },
  { id: "bill-installs", agentId: "bill", task: "Today's installs and materials for JD PM: what's scheduled, what's missing, what needs ordering. Flag anything that would delay a job.", when: "weekdays@06:30", phase: 1 },
  { id: "nick-weekly", agentId: "nick", task: "Philneeds weekly analytics: what posts worked and why (x_own_posts, x_mentions), what to post more of, and next week's plan for Boo and ncrypt.", when: "weekly:mon@09:00", phase: 2, push: true },
  { id: "poseidon-weekly", agentId: "poseidon", task: "Range.cool weekly metrics: the key numbers, what moved and why, runway, and the decisions that need Phil.", when: "weekly:mon@08:15", phase: 3, push: true },
  { id: "oscar-inbox", agentId: "oscar", task: "Weekly inbox cleanup with Monica. For each of Phil's personal Google accounts: use gmail_senders on 'in:inbox older_than:14d' and 'category:promotions older_than:30d', then propose ONE archive plan per account as an approval (gmail.archive by query, with the match count in the body). Never trash. Keep anything from a real person or about money, travel, health or a job.", when: "weekly:sun@04:00", phase: 0 },
  { id: "monica-day", agentId: "monica", task: "Lay out Phil's day for him to read on his phone: what's on the calendar across his accounts, conflicts, what's unscheduled, what to protect. Propose any calendar change as an approval; change nothing yourself.", when: "daily@06:45", phase: 0, push: true },
  { id: "stella-leads", agentId: "stella", task: "Review new leads and open jobs for JD PM; flag anything waiting on a customer reply.", when: "daily@06:50", phase: 1 },
  { id: "mantis-markets", agentId: "mantis", task: "Market read for the day: what moved on-chain overnight and what the team should watch.", when: "daily@06:55", phase: 1 },
  { id: "ansem-scan", agentId: "ansem", task: "Scan: new memecoins and low caps worth a look, with the reason each is on the list.", when: "every:240", phase: 2 },
  { id: "pentoshi-scan", agentId: "pentoshi", task: "Scan: funding rates, perps positioning, prop-firm news.", when: "every:240", phase: 2 },
  { id: "marcus-open", agentId: "marcus", task: "Pre-market: tech and infra holdings, catalysts today, suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "house-open", agentId: "house", task: "Pre-market: biotech holdings, catalysts and approvals today, suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "exxon-open", agentId: "exxon", task: "Pre-market: energy holdings and catalysts today, suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "altman-open", agentId: "altman", task: "Pre-market: AI-era holdings and catalysts today, suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "armstrong-open", agentId: "armstrong", task: "Pre-market: crypto-niche stocks and catalysts today, suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "munger-weekly", agentId: "munger", task: "Weekly money summary for Phil, short enough to read on his phone. Call kubera_networth: net worth now, the change this week and this month, the biggest movers and why if you can tell, and any account that stopped syncing. Then one thing to do this week. Read only; never suggest moving money without an approval.", when: "weekly:mon@07:30", phase: 2, push: true },
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
      if (s.when.startsWith("weekdays@") && (now.getDay() === 0 || now.getDay() === 6)) return false;
      const mo = s.when.match(/^monthly:(\d{1,2})@/);
      if (mo && now.getDate() !== Number(mo[1])) return false;
      const wk = s.when.match(/^weekly:(sun|mon|tue|wed|thu|fri|sat)@(\d{2}):(\d{2})$/);
      if (wk && ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getDay()] !== wk[1]) return false;
      const m = s.when.match(/^(?:daily|weekdays|weekly:[a-z]{3}|monthly:\d{1,2})@(\d{2}):(\d{2})$/);
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
      // The log gets a schedule line only once the run did something Phil can see; a skipped or blocked timer stays out of it.
      const done = (what: string, runId?: string) => this.jarvis.router.log(agent.id, "schedule", `Scheduled: ${s.id} · ${what}`, runId);
      try {
        if (s.task === "brief") {
          const text = await this.jarvis.brief();
          await this.jarvis.say({ role: "jarvis", text: `Daily brief\n\n${text}` });
          bus.emitEvent({ type: "brief", text, at: new Date().toISOString() });
          bus.emitEvent({ type: "report", agentId: "jarvis", title: "Daily brief", text, at: new Date().toISOString() });
          await done("daily brief sent");
        } else if (s.task === "condense") {
          if ((await this.jarvis.store.memory.list()).length >= 20) {
            const text = await this.jarvis.condenseMemory();
            await this.jarvis.say({ role: "system", text });
            await done(text.split("\n")[0]!.slice(0, 120));
          }
        } else {
          const r = await this.jarvis.runAgent(agent, s.task, { direct: false, from: "Scheduler" });
          if (!r.blocked) {
            await this.jarvis.say({ role: "agent", agentId: agent.id, text: r.text, runId: r.runId });
            if (s.push) bus.emitEvent({ type: "report", agentId: agent.id, title: s.id === "monica-day" ? "Your day" : s.id === "david-weekly" ? "David: goals this week" : s.id === "einstein-weekly" ? "Einstein's weekly review" : s.id === "adam-monthly" ? "Adam: this month's goals" : `${agent.name} report`, text: r.text, at: new Date().toISOString() });
            await done(`${agent.name} reported back`, r.runId);
          }
        }
      } catch (e) {
        await this.jarvis.router.log(agent.id, "error", `Schedule ${s.id} failed: ${(e as Error).message}`);
      }
    }
    bus.emitEvent({ type: "system", status: await this.jarvis.systemStatus() });
  }
}
