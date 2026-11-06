import type { Store } from "./store/types.js";
import { bus } from "./events.js";
import type { Jarvis } from "./jarvis/orchestrator.js";
import { AGENTS, getAgent } from "./registry/index.js";
import { getAgentConfig } from "./config.js";
import { listDecks } from "./decks.js";
import { listDataFiles } from "./salesdata.js";

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
  /** Makes a deck from uploaded data: skipped when one was already made by hand from the same data. */
  deck?: boolean;
}

/** Scouts and briefs on their timers. Nothing runs before its phase. */
export const SCHEDULES: Schedule[] = [
  { id: "daily-brief", agentId: "jarvis", task: "brief", when: process.env.BRIEF_AT ? `daily@${process.env.BRIEF_AT}` : "daily@07:00", phase: 0 },
  { id: "oscar-condense", agentId: "oscar", task: "condense", when: "daily@03:30", phase: 0 },
  { id: "einstein-weekly", agentId: "einstein", task: "Weekly review for Phil, short enough to read on his phone. Call web_health for the last 7 days. Then: the three changes you'd make this week and why (errors to fix, slow or idle agents, usage, approvals Phil keeps rejecting); where each of Phil's ideas on your list stands; anything to cut, for Oscar. Put each change you want made as an approval (kind config) so Phil can say yes or no.", when: "weekly:sun@19:00", phase: 0, push: true },
  { id: "adam-monthly", agentId: "adam", task: "Monthly goals session with Phil. Call goals_list for where his current goals stand, and look at each venture's board. Then: one line on how last month went against each goal; then propose this month's goals (one primary, up to two more), each specific and measurable with a deadline, and why each matters now. Put the proposal in one approval with payload {\"action\":\"goals.set\",\"add\":[{\"name\":\"...\",\"deadline\":\"YYYY-MM-DD\",\"primary\":true}],\"retire\":[\"<id of a goal that is done or dropped>\"]}. Phil will question or change it on the card before approving.", when: "monthly:1@08:00", phase: 0, push: true },
  { id: "buffett-weekly", agentId: "buffett", task: "Weekly holdings review after Friday's close, short enough to read on a phone. Read the holdings (kubera_items; everything is at Robinhood). Say how each did this week, what the scouts flagged, and at most three suggested changes, each as an approval with the reason. Then keep the scouts informed: a remember block with scope venture:money and key holdings listing the tickers by sector. And add any stock Phil talked about this week (chat_recent) to the watchlist as a record with status watch.", when: "weekly:fri@16:45", phase: 2, push: true },
  { id: "david-weekly", agentId: "david", task: "Weekly goals check: call goals_list. Any goal without benchmarks gets them first (goals.benchmarks: 3 to 6 concrete, checkable, weighted). For each goal: which benchmarks were met this week and the evidence (tick them with a goals.update approval block, done: [benchmark ids]), where it stands, the next benchmark to hit, and the one or two steps that get there next week. Flag any goal that's slipping against its deadline. Only move the bar on evidence.", when: "weekly:sun@18:00", phase: 0, push: true },
  { id: "karol-leads", agentId: "karol", task: "Morning lead check for JD PM: new leads since yesterday, each logged on the board, and a first reply drafted for every one that hasn't had one.", when: "daily@07:15", phase: 1 },
  { id: "bill-installs", agentId: "bill", task: "Today's installs and materials for JD PM: what's scheduled, what's missing, what needs ordering. Flag anything that would delay a job.", when: "weekdays@06:30", phase: 1 },
  { id: "nick-weekly", agentId: "nick", task: "Philneeds weekly analytics: what posts worked and why (x_own_posts, x_mentions), what to post more of, and next week's plan for Boo and ncrypt.", when: "weekly:mon@09:00", phase: 2, push: true },
  { id: "poseidon-weekly", agentId: "poseidon", task: "Range.cool weekly metrics: the key numbers, what moved and why, runway, and the decisions that need Phil.", when: "weekly:mon@08:15", phase: 3, push: true },
  { id: "oscar-inbox", agentId: "oscar", task: "Weekly inbox cleanup with Monica. For each of Phil's personal Google accounts: use gmail_senders on 'in:inbox older_than:14d' and 'category:promotions older_than:30d', then propose ONE archive plan per account as an approval (gmail.archive by query, with the match count in the body). Never trash. Keep anything from a real person or about money, travel, health or a job.", when: "weekly:sun@04:00", phase: 0 },
  { id: "monica-day", agentId: "monica", task: "Lay out Phil's day for him to read on his phone: what's on the calendar across his accounts, conflicts, what's unscheduled, what to protect. Propose any calendar change as an approval; change nothing yourself.", when: "daily@06:45", phase: 0, push: true },
  { id: "stella-leads", agentId: "stella", task: "Review new leads and open jobs for JD PM; flag anything waiting on a customer reply.", when: "daily@06:50", phase: 1 },
  { id: "mantis-markets", agentId: "mantis", task: "Market read for the day. Call hyperliquid_perps for real numbers: BTC, ETH and SOL, the biggest moves, where funding and open interest are stretched. Say what moved overnight and what the team should watch today. Use only the numbers you were given; if you don't have data on something, say so instead of guessing.", when: "daily@06:55", phase: 1 },
  { id: "ansem-scan", agentId: "ansem", task: "Scan: new memecoins and low caps worth a look, with the reason each is on the list.", when: "every:240", phase: 2 },
  { id: "pentoshi-scan", agentId: "pentoshi", task: "Scan Hyperliquid with hyperliquid_perps: what changed since your last scan in funding (both extremes), open interest and the biggest moves, and what it says about positioning. Keep it to what's worth Phil's attention, with the numbers; say \"nothing notable\" when that's the truth. Add what traders on X are saying about the biggest moves (your own X search), with handles. Then any news from Phil's prop firms (Vest Markets, Backed). Save this scan's key numbers in a remember block (scope agent:pentoshi, key last-scan) so the next scan can compare.", when: "every:240", phase: 2 },
  { id: "marcus-open", agentId: "marcus", task: "Pre-market: tech and infra holdings, catalysts today, suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "house-open", agentId: "house", task: "Pre-market: biotech holdings, catalysts and approvals today, and what the biotech Discord said overnight (discord_recent, quoted as chat, not fact). Suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "exxon-open", agentId: "exxon", task: "Pre-market: energy holdings and catalysts today, suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "altman-open", agentId: "altman", task: "Pre-market: AI-era holdings and catalysts today, suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "armstrong-open", agentId: "armstrong", task: "Pre-market: crypto-niche stocks and catalysts today, suggested changes for Buffett.", when: "weekdays@08:30", phase: 2 },
  { id: "stevon-weekly", agentId: "stevon", task: "Build the deck for Tuesday morning's ProEdge sales meeting. Call deck_template, then sales_data (days 8 for this week; days 15 as well when there's an earlier week to compare). If nothing was uploaded this week, make no deck: reply in two lines asking Phil to upload this week's sales data (on your page in HQ, or send the spreadsheet to Jarvis on Telegram) and press Make the deck now. Otherwise write the deck as a slides block, following the template's order when there is one: the cover (ProEdge weekly sales, with the week's dates), the headline numbers against last week, results by rep or service where the data has it, what's working and what isn't, and the focus for this week. Speaker notes on every slide for what Phil should say. Use only numbers from the data. Outside the block, give the three headlines in a few lines.", when: "weekly:mon@20:00", phase: 1, push: true, deck: true },
  { id: "boo-voice", agentId: "boo", task: "Review the @philneeds X account (Grok's X search, or x_own_posts if X is connected): Phil's recent posts and replies, what got the most engagement, and how he writes. Update your voice guide: the topics he posts about, tone, length, format, phrases he uses and avoids, and what lands best, with two or three example posts. Save it in a remember block (scope venture:philneeds, key voice-guide), replacing the old one. Reply with a short summary of what changed.", when: "monthly:1@10:00", phase: 2 },
  { id: "munger-weekly", agentId: "munger", task: "Weekly money summary for Phil, short enough to read on his phone. Call kubera_networth: net worth now, the change this week and this month, the biggest movers and why if you can tell, and any account that stopped syncing. Then analyse: call kubera_history (90 days) and memory_search for your earlier patterns (scope venture:money), and say what pattern you see (a recurring drain, spending creep, an account drifting, what moves net worth most), whether last week's patterns held, and one or two improvements, each with the reason and the expected effect. Save any pattern worth tracking in a remember block (scope venture:money, key money-pattern-<short name>). Read only; never suggest moving money without an approval.", when: "weekly:mon@07:30", phase: 2, push: true },
];

const LAST_RUN_KEY = "schedule.lastRun";

/** The built-in routines plus each agent's own schedule from its settings. */
export async function withCustom(store: Store, schedules: Schedule[] = SCHEDULES): Promise<Schedule[]> {
  const custom: Schedule[] = [];
  for (const a of AGENTS) {
    const c = await getAgentConfig(store, a.id);
    if (c.schedule?.enabled && c.schedule.when && c.schedule.task) custom.push({ id: `custom:${a.id}`, agentId: a.id, task: c.schedule.task, when: c.schedule.when, phase: 0 });
  }
  return [...schedules, ...custom];
}

const DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAME = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const clock = (h: number, m: number) => `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "weekly:sun@19:00" → "Sundays at 7:00 pm". */
export function describeWhen(when: string): string {
  let m = when.match(/^every:(\d+)$/);
  if (m) { const n = Number(m[1]); return n % 60 === 0 ? (n === 60 ? "Every hour" : `Every ${n / 60} hours`) : `Every ${n} minutes`; }
  m = when.match(/^(daily|weekdays|weekly:([a-z]{3})|monthly:(\d{1,2}))@(\d{2}):(\d{2})$/);
  if (!m) return when;
  const t = clock(Number(m[4]), Number(m[5]));
  if (m[1] === "daily") return `Daily at ${t}`;
  if (m[1] === "weekdays") return `Weekdays at ${t}`;
  if (m[2]) return `${DAY_NAME[DAY.indexOf(m[2])] ?? m[2]} at ${t}`;
  return `${ord(Number(m[3]))} of each month at ${t}`;
}

/** When a routine next runs after `now` (server local time, as the scheduler uses). */
export function nextRun(when: string, now: Date, last?: number): Date | undefined {
  const ev = when.match(/^every:(\d+)$/);
  if (ev) { const ms = Number(ev[1]) * 60_000; return new Date(Math.max(now.getTime(), (last ?? 0) + ms)); }
  const m = when.match(/^(daily|weekdays|weekly:([a-z]{3})|monthly:(\d{1,2}))@(\d{2}):(\d{2})$/);
  if (!m) return undefined;
  for (let i = 0; i < 40; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(Number(m[4]), Number(m[5]), 0, 0);
    if (d.getTime() <= now.getTime()) continue;
    if (m[1] === "weekdays" && (d.getDay() === 0 || d.getDay() === 6)) continue;
    if (m[2] && DAY[d.getDay()] !== m[2]) continue;
    if (m[3] && d.getDate() !== Number(m[3])) continue;
    return d;
  }
  return undefined;
}

export interface ScheduleView { id: string; agentId: string; when: string; whenText: string; summary: string; task: string; phase: number; active: boolean; push: boolean; custom: boolean; deck: boolean; lastRun?: string; nextRun?: string }

/** One plain line per built-in routine for the Schedules screen; the full instructions sit behind "details". */
const SUMMARY: Record<string, string> = {
  "daily-brief": "The morning brief: each lead's report, what's waiting on you, today's calendar.",
  "oscar-condense": "Tidies memory: merges duplicates and drops what's stale.",
  "oscar-inbox": "Inbox cleanup plan for each account, sent to you as approvals. Never trashes.",
  "einstein-weekly": "Weekly review: what to fix or improve, where your ideas stand, what to cut.",
  "adam-monthly": "Goals session: how last month went, and this month's goals for your OK.",
  "monica-day": "Your day: the calendar across your accounts, conflicts, and what to protect.",
  "stella-leads": "Leads and jobs review; flags anything waiting on a customer.",
  "karol-leads": "New-lead check: logs new leads and drafts first replies for your OK.",
  "bill-installs": "Today's installs and materials, and anything that would delay a job.",
  "mantis-markets": "Market read: what moved on-chain overnight and what to watch.",
  "ansem-scan": "New memecoins and low caps worth a look, each with the reason.",
  "pentoshi-scan": "Hyperliquid funding, open interest and big moves, plus prop-firm news.",
  "buffett-weekly": "Holdings review after the close, up to three suggested changes; updates the watchlist.",
  "david-weekly": "Goals check: benchmarks met, where each goal stands, next week's steps.",
  "stevon-weekly": "Tuesday meeting deck from this week's sales data (a PowerPoint).",
  "boo-voice": "Reviews @philneeds and refreshes Phil's voice guide.",
  "munger-weekly": "Money summary: net worth, what changed, the patterns behind it, and one or two improvements.",
  "nick-weekly": "Philneeds analytics: what worked and next week's plan for Boo and ncrypt.",
  "poseidon-weekly": "Range.cool metrics, runway and the decisions that need you.",
  "marcus-open": "Pre-market notes on tech and infrastructure stocks, for Buffett.",
  "house-open": "Pre-market notes on biotech stocks, for Buffett.",
  "exxon-open": "Pre-market notes on energy stocks, for Buffett.",
  "altman-open": "Pre-market notes on AI-era stocks, for Buffett.",
  "armstrong-open": "Pre-market notes on crypto-linked stocks, for Buffett.",
};

/** Every routine for the Schedules screen: what, when, whether it's on in this phase, last and next run. */
export async function scheduleView(store: Store, now = new Date(), schedules: Schedule[] = SCHEDULES): Promise<ScheduleView[]> {
  const phase = await store.settings.get("phase", 0);
  const last = await store.settings.get<Record<string, number>>(LAST_RUN_KEY, {});
  return (await withCustom(store, schedules)).map((s) => {
    const active = s.phase <= phase;
    const n = active ? nextRun(s.when, now, last[s.id]) : undefined;
    return {
      id: s.id, agentId: s.agentId, when: s.when, whenText: describeWhen(s.when),
      summary: SUMMARY[s.id] ?? (s.task.length > 140 ? `${s.task.slice(0, 140).replace(/\s+\S*$/, "")}…` : s.task),
      task: s.task === "brief" ? "The morning brief: each lead's report, what's waiting on Phil, today's calendar." : s.task === "condense" ? "Tidy memory: merge duplicates and drop what's stale (when memory passes 20 items)." : s.task,
      phase: s.phase, active, push: !!s.push || s.task === "brief", custom: s.id.startsWith("custom:"), deck: !!s.deck,
      lastRun: last[s.id] ? new Date(last[s.id]!).toISOString() : undefined, nextRun: n?.toISOString(),
    };
  });
}

const REPORT_TITLE: Record<string, string> = { "monica-day": "Your day", "david-weekly": "David: goals this week", "einstein-weekly": "Einstein's weekly review", "adam-monthly": "Adam: this month's goals", "stevon-weekly": "Stevon: Tuesday meeting deck" };

/** One agent routine, now: the agent runs its task, the answer lands in chat, and a push routine goes to Telegram (with any deck). */
export async function runRoutine(jarvis: Jarvis, s: Schedule, opts: { direct?: boolean } = {}) {
  const agent = getAgent(s.agentId);
  if (!agent || s.task === "brief" || s.task === "condense") return undefined;
  // A deck routine on its timer skips when Phil already had a deck made by hand since the last data upload.
  if (s.deck && !opts.direct) {
    const lastDeck = (await listDecks(jarvis.store, agent.venture)).find((d) => d.agentId === agent.id);
    const lastData = (await listDataFiles(jarvis.store, agent.venture))[0];
    if (lastDeck && Date.now() - Date.parse(lastDeck.at) < 24 * 3_600_000 && (!lastData || Date.parse(lastData.at) <= Date.parse(lastDeck.at))) {
      await jarvis.router.log(agent.id, "schedule", `Scheduled: ${s.id} · skipped, the deck was already made at ${lastDeck.at.slice(11, 16)} UTC from the latest data`);
      return undefined;
    }
  }
  const r = await jarvis.runAgent(agent, s.task, { direct: opts.direct ?? false, from: "Scheduler" });
  if (r.blocked) return r;
  const files = "decks" in r ? r.decks?.map((d) => ({ id: d.id, name: d.name })) : undefined;
  await jarvis.say({ role: "agent", agentId: agent.id, text: r.text, runId: r.runId, files: files?.length ? files : undefined });
  if (s.push) bus.emitEvent({ type: "report", agentId: agent.id, title: REPORT_TITLE[s.id] ?? `${agent.name} report`, text: r.text, at: new Date().toISOString(), files });
  return r;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private lastRun = new Map<string, number>();
  private loaded = false;
  constructor(private jarvis: Jarvis, private schedules: Schedule[] = SCHEDULES) {}

  start(tickMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Phil's per-agent schedules from agent settings, merged over the built-in ones. */
  async allSchedules(): Promise<Schedule[]> { return withCustom(this.jarvis.store, this.schedules); }

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
    // Last runs survive a restart, so a routine never runs twice in its window and the Schedules screen can show them.
    if (!this.loaded) { this.loaded = true; for (const [k, v] of Object.entries(await this.jarvis.store.settings.get<Record<string, number>>(LAST_RUN_KEY, {}))) if (!this.lastRun.has(k)) this.lastRun.set(k, v); }
    for (const s of this.due(now, phase, await this.allSchedules())) {
      this.lastRun.set(s.id, now.getTime());
      await this.jarvis.store.settings.set(LAST_RUN_KEY, Object.fromEntries(this.lastRun));
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
          const r = await runRoutine(this.jarvis, s);
          if (r && !r.blocked) await done(`${agent.name} reported back`, r.runId);
        }
      } catch (e) {
        await this.jarvis.router.log(agent.id, "error", `Schedule ${s.id} failed: ${(e as Error).message}`);
      }
    }
    bus.emitEvent({ type: "system", status: await this.jarvis.systemStatus() });
  }
}
