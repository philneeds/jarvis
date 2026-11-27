import type { Store } from "./store/types.js";
import { bus } from "./events.js";
import type { Jarvis } from "./jarvis/orchestrator.js";
import { AGENTS, getAgent, type AgentDef } from "./registry/index.js";
import { getAgentConfig } from "./config.js";
import { listDecks } from "./decks.js";
import { listDataFiles } from "./salesdata.js";
import { deployPending } from "./deployhold.js";
import { isUsageLimit } from "./router/claude.js";

export interface Schedule {
  id: string;
  agentId: string;
  /** Task text sent to the agent, or "brief" for Jarvis's daily brief. */
  task: string;
  /** "every:<minutes>" or "daily@HH:MM" (server local time). */
  when: string;
  /** Phase in which this schedule becomes active. */
  phase: number;
  /**
   * The sources this routine reads ("mail", "ghl", "health", "memory"). On its timer it runs only when one of them has
   * something new since its last run (at least once a week regardless); a run Phil asks for always runs.
   */
  watch?: string[];
  /** A deliverable for Phil himself (the daily brief, Stevon's deck): sent to him on Telegram and in chat. */
  push?: boolean;
  /** Makes a deck from uploaded data: skipped when one was already made by hand from the same data. */
  deck?: boolean;
  /**
   * Who the answer goes to. Default: the agent's own lead (its parent), and leads report to Jarvis, who folds it into the
   * daily brief. Phil hears directly only from Jarvis, from Needs you, and from the few routines with push (deliverables).
   */
  to?: string;
}

/** Scouts and briefs on their timers. Nothing runs before its phase. */
export const SCHEDULES: Schedule[] = [
  { id: "daily-brief", agentId: "jarvis", task: "brief", when: process.env.BRIEF_AT ? `daily@${process.env.BRIEF_AT}` : "daily@07:00", phase: 0 },
  { id: "oscar-condense", agentId: "oscar", task: "condense", when: "daily@03:30", phase: 0 },
  { id: "backup-nightly", agentId: "jarvis", task: "backup", when: "daily@03:15", phase: 0 },
  // Code on GitHub that HQ isn't running yet becomes one "Update HQ" card under Needs you: no SSH to update.
  { id: "hq-update-check", agentId: "jarvis", task: "update-check", when: "every:60", phase: 0 },
  { id: "setup-check", agentId: "jarvis", task: "setup-check", when: "every:60", phase: 0 },
  // Benchmarks with a rule against live data (Kubera, the boards) tick and untick themselves.
  { id: "goal-check", agentId: "jarvis", task: "goal-check", when: "every:60", phase: 0 },
  // Every connection checked for real; Phil hears only when one that worked stops (twice in a row), and when it's back.
  { id: "connections-watch", agentId: "jarvis", task: "connections-watch", when: "every:180", phase: 0 },
  { id: "einstein-weekly", agentId: "einstein", task: "Weekly review for Phil, short enough to read on his phone. Call web_health for the last 7 days. Then: the three changes you'd make this week and why (errors to fix, slow or idle agents, usage, approvals Phil keeps rejecting); where each of Phil's ideas on your list stands; anything to cut, for Oscar. Changes to HQ's own code: build them in your workshop, verify, and submit (workshop_submit) so Phil can ship each one from Needs you. Anything else you want changed (a setting, a plan, a key Phil must add): an approval (kind config) so Phil can say yes or no.", when: "weekly:sun@19:00", phase: 0 },
  { id: "adam-monthly", agentId: "adam", task: "Monthly goals session with Phil. Call goals_list for where his current goals stand, and look at each venture's board. Then: one line on how last month went against each goal; then propose this month's goals (one primary, up to two more), each specific and measurable with a deadline, and why each matters now. Put the proposal in one approval with payload {\"action\":\"goals.set\",\"add\":[{\"name\":\"...\",\"deadline\":\"YYYY-MM-DD\",\"primary\":true}],\"retire\":[\"<id of a goal that is done or dropped>\"]}. Phil will question or change it on the card before approving.", when: "monthly:1@08:00", phase: 0 },
  { id: "buffett-weekly", agentId: "buffett", task: "Weekly holdings review after Friday's close, short enough to read on a phone. Read the holdings (kubera_items; everything is at Robinhood). Say how each did this week, what the scouts flagged, and at most three suggested changes, each as an approval with the reason. Then keep the scouts informed: a remember block with scope venture:money and key holdings listing the tickers by sector. And add any stock Phil talked about this week (chat_recent) to the watchlist as a record with status watch.", when: "weekly:fri@16:45", phase: 2 },
  { id: "david-today", agentId: "david", task: "Pick Phil's three for today. Call goals_list and web_status. Choose the three things that most move his goals or unblock an agent today: an unmet benchmark he can finish today (shortest horizon first), or something waiting on his decision. Send them as one today.set approval block (see your charter): at most three items, each short, concrete and finishable today, with goalId and benchmarkId when the item is a benchmark. If there are no goals and nothing is waiting, send nothing and say so in one line. Keep your written reply to two lines.", when: "daily@06:40", phase: 0 },
  { id: "david-weekly", agentId: "david", task: "Weekly goals check: call goals_list. Any goal without benchmarks gets them first (goals.benchmarks: 3 to 6 concrete, checkable, weighted). For each goal: which benchmarks were met this week and the evidence (tick them with a goals.update approval block, done: [benchmark ids]), where it stands, the next benchmark to hit, and the one or two steps that get there next week. Flag any goal that's slipping against its deadline. Only move the bar on evidence.", when: "weekly:sun@18:00", phase: 0 },
  { id: "karol-leads", agentId: "karol", watch: ["ghl", "mail"], task: "Morning lead check for JD PM: new leads since yesterday, each logged on the board as its own lead (name, phone, source), and a first reply drafted for every one that hasn't had one. If there are none, log nothing on the board and say so in one line. The leads_week number is the leads added in the last 7 days, not today's.", when: "daily@07:15", phase: 1 },
  { id: "bill-installs", agentId: "bill", task: "Today's installs and materials for JD PM: what's scheduled, what's missing, what needs ordering. Flag anything that would delay a job.", when: "weekdays@06:30", phase: 1 },
  { id: "nick-weekly", agentId: "nick", task: "Philneeds weekly analytics: what posts worked and why (x_own_posts, x_mentions), what to post more of, and next week's plan for Boo and ncrypt.", when: "weekly:mon@09:00", phase: 2 },
  { id: "poseidon-weekly", agentId: "poseidon", task: "Range.cool weekly metrics: the key numbers, what moved and why, runway, and the decisions that need Phil.", when: "weekly:mon@08:15", phase: 3 },
  { id: "oscar-inbox", agentId: "oscar", task: "Weekly inbox cleanup with Monica. For each of Phil's personal Google accounts: use gmail_senders on 'in:inbox older_than:14d' and 'category:promotions older_than:30d', then propose ONE archive plan per account as an approval (gmail.archive by query, with the match count in the body). Never trash. Keep anything from a real person or about money, travel, health or a job. Then the unsubscribe sweep (Phil's standing rule, Nov 27 2026; the full rule is in your memory as unsubscribe_sweep_standing_rule): across philneedsofficial@gmail.com, pmarino9081@gmail.com and info@jdpmrenovations.com, use gmail_senders one 30-day window at a time ('category:promotions newer_than:30d', then 'older_than:30d newer_than:60d'; for the JD PM mailbox also updates and forums) and pick the promo and newsletter senders Phil leaves unread: 3+ emails in 60 days, most of them unread. Skip banks and cards, Kubera, Robinhood, Kalshi, crypto and trading, GoHighLevel, KLL Digital, GAF, suppliers, customers, ProEdge, LeadPerfection, Google, receipts, travel, jobs and health, and any sender Phil already approved or rejected in an earlier sweep. File ONE approval card for the whole sweep (kind other): a batch with one gmail.unsubscribe step per mailbox (its senders' addresses) and one gmail.label 'Unsubscribe candidates' step per mailbox; in the body, one line per sender with name, address, mailbox, emails per month (last 30d / prior 30d), % unread, and how it unsubscribes (one-click, mailto, or link for Phil to open). Nothing is unsubscribed, filtered or deleted until Phil approves.", when: "weekly:sun@04:00", phase: 0 },
  { id: "monica-day", agentId: "monica", task: "Lay out Phil's day for him to read on his phone. Read all five of his calendars, one calendar_list_events call per account: philneedsofficial@gmail.com, pmarino9081@gmail.com, info@jdpmrenovations.com, pmarino@getproedge.com, rangedotzone@gmail.com (Phil, Nov 13 2026; this replaces any older note limiting you to the personal accounts). Say which calendar each event is on and name any account that failed to read. Then: conflicts across all five, what's unscheduled, what to protect. Propose any calendar change as an approval; change nothing yourself. A change on a business calendar goes to that venture's lead as a handoff or to Phil as an approval.", when: "daily@06:45", phase: 0 },
  { id: "stella-leads", agentId: "stella", watch: ["ghl", "mail"], task: "Review new leads and open jobs for JD PM; flag anything waiting on a customer reply.", when: "daily@06:50", phase: 1 },
  { id: "mantis-markets", agentId: "mantis", task: "Market read for the day. Call hyperliquid_perps for real numbers: BTC, ETH and SOL, the biggest moves, where funding and open interest are stretched. Say what moved overnight and what the team should watch today. Use only the numbers you were given; if you don't have data on something, say so instead of guessing.", when: "daily@06:55", phase: 1 },
  { id: "ansem-scan", agentId: "ansem", task: "Scan: new memecoins and low caps worth a look, with the reason each is on the list. This goes to Mantis, not Phil.", when: "every:240", phase: 2, to: "mantis" },
  { id: "pentoshi-scan", agentId: "pentoshi", task: "Scan Hyperliquid with hyperliquid_perps: what changed since your last scan in funding (both extremes), open interest and the biggest moves, and what it says about positioning. Keep it to what's worth Phil's attention, with the numbers; say \"nothing notable\" when that's the truth. Add what traders on X are saying about the biggest moves (x_search), with handles. Then any news from Phil's prop firms (Vest Markets, Backed). Save this scan's key numbers in a remember block (scope agent:pentoshi, key last-scan) so the next scan can compare.", when: "every:240", phase: 2, to: "mantis" },
  { id: "marcus-open", agentId: "marcus", task: "Pre-market: tech and infra holdings, catalysts today, suggested changes. This goes to Munger, not Phil.", when: "weekdays@08:30", phase: 2, to: "munger" },
  { id: "house-open", agentId: "house", task: "Pre-market: biotech holdings, catalysts and approvals today, and what the biotech Discord said overnight (discord_recent, quoted as chat, not fact). Suggested changes. This goes to Munger, not Phil.", when: "weekdays@08:30", phase: 2, to: "munger" },
  { id: "exxon-open", agentId: "exxon", task: "Pre-market: energy holdings and catalysts today, suggested changes. This goes to Munger, not Phil.", when: "weekdays@08:30", phase: 2, to: "munger" },
  { id: "altman-open", agentId: "altman", task: "Pre-market: AI-era holdings and catalysts today, suggested changes. This goes to Munger, not Phil.", when: "weekdays@08:30", phase: 2, to: "munger" },
  { id: "armstrong-open", agentId: "armstrong", task: "Pre-market: crypto-niche stocks and catalysts today, suggested changes. This goes to Munger, not Phil.", when: "weekdays@08:30", phase: 2, to: "munger" },
  { id: "stevon-weekly", agentId: "stevon", task: "Build the deck for Tuesday morning's ProEdge sales meeting. Get the numbers from LeadPerfection with lp_report (Sales Efficiency by Sales Rep, all markets): for the period deck_period gives (call it first: month to date, the 1st through today, and the same days of the month before for comparison; never a single week). Use the numbers HQ works out from the report as given (close to issue, demo rate, NSLI with 70% of pre-net, cancel rate, pending vs net, per rep and team). (lp_deck_numbers pulls both in one step.) Then call deck_template. If the template already carries {{codes}} where its figures go, HQ fills every one of them itself: send a deckfill with the title, the numbers line, and edits only for words (headlines, takeaways, action items), or an empty edit list; change no figure. Otherwise, if Phil has a template, fill it in with a deckfill block: change every number, date and name on his slides to this period's, leaving his layout alone. Every sales figure is a {{code}} HQ fills from the report (the deck hint lists them; copy the numbers line deck_period gives), never a number you type; list any chart that needs updating by hand. With no template, write a slides block: the cover (ProEdge sales, with the period's dates), team numbers against the comparison period, a table by rep, what's working and what isn't, and the focus for this week, with speaker notes. Use only numbers from the reports. If lp_report fails, say its error in one line and stop. Outside the block, give the three headlines in a few lines.", when: "weekly:mon@21:00", phase: 1, push: true, deck: true },
  { id: "auditor-weekly", agentId: "auditor", task: "Weekly accounting audit for ProEdge. This goes to Stevon, not Phil. First, what was paid: call sales_data (days=15) for any commission or payroll statement Phil uploaded, and gmail_search on pmarino@getproedge.com (newer_than:14d, words like commission, payroll, pay statement) for one sent by email, read with gmail_attachment. Then the figures: lp_report (Sales Efficiency by Sales Rep, all markets) for the same pay period, per rep, using the numbers HQ works out from the report as given. Work out what each rep should have earned under the commission rules in your memory (skill:commission_rules) and compare with what the statement says was paid. Report, short: per rep, expected against paid and the gap with its likely cause; team totals; anything in the report itself that doesn't add up (a cancel counted as a sale, pre-net still pending). A confirmed gap goes on the ProEdge board once as a record of kind discrepancy. Use only the numbers you were given: with no statement, say so in one line and report the sales figures alone; with no commission rules yet, say so and ask Stevon to get them from Phil, once; if lp_report fails, say its error in one line and stop.", when: "weekly:fri@07:00", phase: 1, to: "stevon" },
  { id: "boo-voice", agentId: "boo", task: "Review the @philneeds X account (x_search, or x_own_posts if X is connected): Phil's recent posts and replies, what got the most engagement, and how he writes. Update your voice guide: the topics he posts about, tone, length, format, phrases he uses and avoids, and what lands best, with two or three example posts. Save it in a remember block (scope venture:philneeds, key voice-guide), replacing the old one. Reply with a short summary of what changed.", when: "monthly:1@10:00", phase: 2 },
  { id: "munger-weekly", agentId: "munger", task: "Weekly money summary for Phil, short enough to read on his phone. Call kubera_networth: net worth now, the change this week and this month, the biggest movers and why if you can tell, and any account that stopped syncing. Then analyse: call kubera_history (90 days) and memory_search for your earlier patterns (scope venture:money), and say what pattern you see (a recurring drain, spending creep, an account drifting, what moves net worth most), whether last week's patterns held, and one or two improvements, each with the reason and the expected effect. Save any pattern worth tracking in a remember block (scope venture:money, key money-pattern-<short name>). Read only; never suggest moving money without an approval.", when: "weekly:mon@07:30", phase: 2 },
];

const LAST_RUN_KEY = "schedule.lastRun";
/** Routines that came due while an approved update was waiting to restart HQ; they run on the first tick after it. */
export const DEFERRED_KEY = "schedule.deferred";
/** A routine held for an update, and when (older records are bare ids). */
type Deferred = { id: string; at: number };
async function readDeferred(store: Store): Promise<Deferred[]> {
  return (await store.settings.get<(string | Deferred)[]>(DEFERRED_KEY, [])).map((d) => (typeof d === "string" ? { id: d, at: 0 } : d));
}
async function addDeferred(store: Store, ids: string[], at: number): Promise<string[]> {
  const waiting = await readDeferred(store);
  const fresh = [...new Set(ids)].filter((id) => !waiting.some((w) => w.id === id));
  if (fresh.length) await store.settings.set(DEFERRED_KEY, [...waiting, ...fresh.map((id) => ({ id, at }))]);
  return fresh;
}
/** Reports a routine made that would have started the lead's run while an update waited; handed over after it. */
const HELD_REPORTS_KEY = "schedule.heldReports";

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

/** Built-in jobs that aren't an agent's routine: no report goes up the chain, /run leaves them out. */
export const HOUSEKEEPING = new Set(["brief", "condense", "backup", "update-check", "setup-check", "goal-check", "connections-watch"]);

export interface ScheduleView { id: string; agentId: string; when: string; whenText: string; summary: string; task: string; phase: number; active: boolean; push: boolean; custom: boolean; deck: boolean; to?: string; lastRun?: string; nextRun?: string }

/** One plain line per built-in routine for the Schedules screen; the full instructions sit behind "details". */
const SUMMARY: Record<string, string> = {
  "daily-brief": "The morning brief: each lead's report, what's waiting on you, today's calendar.",
  "oscar-condense": "Tidies memory: merges duplicates and drops what's stale. Skipped when nothing new was remembered.",
  "backup-nightly": "Backs up the database, keeps 14 days, copies to Google Drive.",
  "hq-update-check": "Checks GitHub for code HQ isn't running yet; if there is some, an Update HQ card waits under Needs you.",
  "setup-check": "Checks every live agent has its connections and has been tried once; keeps the Command center's setup goal up to date.",
  "connections-watch": "Checks every connection every 3 hours; tells you when one that worked stops, and when it's back.",
  "goal-check": "Ticks goal benchmarks that carry a rule against Kubera or a board figure; unticks them when the rule stops holding.",
  "oscar-inbox": "Inbox cleanup plan per account, plus one unsubscribe sweep card for unread promo senders. Never trashes.",
  "einstein-weekly": "Weekly review: what to fix or improve, where your ideas stand, what to cut.",
  "adam-monthly": "Goals session: how last month went, and this month's goals for your OK.",
  "monica-day": "Your day: all five of your calendars, conflicts, and what to protect.",
  "stella-leads": "Leads and jobs review; flags anything waiting on a customer. Skipped when nothing new came in.",
  "karol-leads": "New-lead check: logs new leads, drafts first replies for your OK. Skipped when nothing new came in.",
  "bill-installs": "Today's installs and materials, and anything that would delay a job.",
  "mantis-markets": "Market read: what moved on-chain overnight and what to watch.",
  "ansem-scan": "New memecoins and low caps worth a look, each with the reason.",
  "pentoshi-scan": "Hyperliquid funding, open interest and big moves, plus prop-firm news.",
  "buffett-weekly": "Holdings review after the close, up to three suggested changes; updates the watchlist.",
  "david-weekly": "Goals check: benchmarks met, where each goal stands, next week's steps.",
  "david-today": "Picks today's three from your goals and what's waiting on you; they open the morning brief.",
  "stevon-weekly": "Monday nights: pulls the month to date from LeadPerfection and fills in your sales meeting template.",
  "auditor-weekly": "Friday audit: ProEdge commissions and sales figures checked against what was paid, for Stevon.",
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
      task: s.task === "brief" ? "The morning brief: each lead's report, what's waiting on Phil, today's calendar." : s.task === "condense" ? "Tidy memory: merge duplicates and drop what's stale (when memory passes 20 items)." : s.task === "backup" ? "Nightly backup of the database, kept 14 days, with a copy to Google Drive." : s.task === "update-check" ? "Hourly check for new code on HQ's branch; an Update HQ card when there is some." : s.task === "setup-check" ? "Hourly check that every live agent is connected and tried; updates the setup goal." : s.task === "goal-check" ? "Hourly: benchmarks with a rule against Kubera or a board figure are ticked or unticked from the live number." : s.task,
      phase: s.phase, active, push: !!s.push || s.task === "brief", custom: s.id.startsWith("custom:"), deck: !!s.deck, to: s.push || HOUSEKEEPING.has(s.task) ? undefined : s.to ?? getAgent(s.agentId)?.parent ?? "jarvis",
      lastRun: last[s.id] ? new Date(last[s.id]!).toISOString() : undefined, nextRun: n?.toISOString(),
    };
  });
}


const REPORT_TITLE: Record<string, string> = { "stevon-weekly": "Stevon: Tuesday meeting deck" };
export const REPORT_INBOX_KEY = "reports.inbox";
export interface QueuedReport { id: string; agentId: string; scheduleId: string; at: string; text: string }

/** The inbox is read-modify-write, so changes to it run one at a time within this process. */
let inboxLock: Promise<unknown> = Promise.resolve();
export function withInbox<T>(fn: () => Promise<T>): Promise<T> { const p = inboxLock.then(fn, fn); inboxLock = p.catch(() => undefined); return p; }

export interface RoutineReport { agent: AgentDef; scheduleId: string; text: string; runId: string }

/** Every report that went up the chain in the last few days, for Jarvis to answer from and for the Reports screen. */
export const REPORTS_LOG_KEY = "reports.log";
export interface LoggedReport { id: string; agentId: string; toId: string; scheduleId: string; at: string; text: string }
const LOG_DAYS = 3;
export async function logReports(jarvis: Jarvis, toId: string, reports: RoutineReport[]) {
  await withInbox(async () => {
    const cutoff = Date.now() - LOG_DAYS * 86_400_000;
    const log = (await jarvis.store.settings.get<LoggedReport[]>(REPORTS_LOG_KEY, [])).filter((r) => Date.parse(r.at) > cutoff);
    await jarvis.store.settings.set(REPORTS_LOG_KEY, [...log, ...reports.map((r) => ({ id: r.runId, agentId: r.agent.id, toId, scheduleId: r.scheduleId, at: new Date().toISOString(), text: r.text.slice(0, 4000) }))].slice(-200));
  });
}
export async function recentReports(store: Store, hours = 48): Promise<LoggedReport[]> {
  const cutoff = Date.now() - hours * 3_600_000;
  return (await store.settings.get<LoggedReport[]>(REPORTS_LOG_KEY, [])).filter((r) => Date.parse(r.at) > cutoff).reverse();
}
/** The reports as a compact block for Jarvis's prompt: newest first, each trimmed, the whole thing capped. */
export function reportsText(reports: LoggedReport[], maxChars = 7000): string {
  const out: string[] = [];
  let used = 0;
  for (const r of reports) {
    const who = getAgent(r.agentId)?.name ?? r.agentId, to = r.toId === "jarvis" ? "you" : getAgent(r.toId)?.name ?? r.toId;
    const line = `- ${r.at.slice(0, 16).replace("T", " ")} ${who} → ${to} (${r.scheduleId}): ${r.text.replace(/\s+/g, " ").slice(0, 400)}`;
    if (used + line.length > maxChars) break;
    out.push(line); used += line.length;
  }
  return out.join("\n");
}

/** Hand one or more reports to the lead they belong to, in one run: they absorb them and raise only what Phil must act on. */
export async function deliverReports(jarvis: Jarvis, toId: string, reports: RoutineReport[]) {
  if (!reports.length) return;
  const to = toId === "jarvis" ? undefined : getAgent(toId);
  await logReports(jarvis, toId, reports);
  if (to) {
    for (const r of reports) await jarvis.router.log(r.agent.id, "run", `${r.agent.name} → ${to.name} (${r.scheduleId}): ${r.text.slice(0, 200)}`, r.runId, { report: r.text });
    const body = reports.map((r) => `${r.agent.name} reports to you (${r.scheduleId}):\n\n${r.text}`).join("\n\n---\n\n");
    const rr = await jarvis.runAgent(to, `${body}\n\nThis is for you, not Phil: keep what matters in memory (scope venture:${to.venture}) and on the board, hand anything actionable to whoever owns it, and raise an attention or approval block only if Phil himself must act. Reply in one or two lines on what you did with ${reports.length > 1 ? "these" : "it"}.`, { direct: false, from: reports.length > 1 ? "The team" : reports[0]!.agent.name, parentRunId: reports[0]!.runId });
    if (!rr.blocked) await jarvis.router.log(to.id, "run", `${to.name} took ${reports.length > 1 ? `${reports.length} reports (${reports.map((r) => r.agent.name).join(", ")})` : `${reports[0]!.agent.name}'s report`}: ${rr.text.slice(0, 200)}`, rr.runId);
    return;
  }
  // A lead's report: into Jarvis's inbox, folded into the next daily brief.
  for (const r of reports) await jarvis.router.log(r.agent.id, "run", `${r.agent.name} → Jarvis (${r.scheduleId}): ${r.text.slice(0, 200)}`, r.runId, { report: r.text });
  await withInbox(async () => {
    const inbox = await jarvis.store.settings.get<QueuedReport[]>(REPORT_INBOX_KEY, []);
    await jarvis.store.settings.set(REPORT_INBOX_KEY, [...inbox, ...reports.map((r) => ({ id: r.runId, agentId: r.agent.id, scheduleId: r.scheduleId, at: new Date().toISOString(), text: r.text.slice(0, 4000) }))].slice(-40));
  });
}

/**
 * One agent routine, now. The answer goes up the chain: to the agent's lead (who absorbs it: memory, board, hand-offs,
 * and an attention or approval only if Phil must act), or, for a lead, to Jarvis's inbox for the next daily brief.
 * Only a deliverable (push) goes to Phil himself, in chat and on Telegram. The Activity log keeps every report.
 * With deliver: false the report is returned instead, so a tick can hand several to the same lead in one go.
 */
export async function runRoutine(jarvis: Jarvis, s: Schedule, opts: { direct?: boolean; deliver?: boolean } = {}) {
  const agent = getAgent(s.agentId);
  if (!agent || HOUSEKEEPING.has(s.task)) return undefined;
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
  if (s.push) {
    const files = "decks" in r ? r.decks?.map((d) => ({ id: d.id, name: d.name })) : undefined;
    await jarvis.say({ role: "agent", agentId: agent.id, text: r.text, runId: r.runId, files: files?.length ? files : undefined });
    bus.emitEvent({ type: "report", agentId: agent.id, title: REPORT_TITLE[s.id] ?? `${agent.name} report`, text: r.text, at: new Date().toISOString(), files });
    return r;
  }
  const toId = s.to ?? agent.parent ?? "jarvis";
  const report: RoutineReport = { agent, scheduleId: s.id, text: r.text, runId: r.runId };
  if (opts.deliver === false) return { ...r, report, toId };
  await deliverReports(jarvis, toId, [report]);
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

  /** Routines running right now, so an overlapping tick never starts the same one twice. */
  private running = new Set<string>();
  /**
   * Scheduled work that didn't happen goes on Phil's Needs-you list, which also reaches his phone. One item per
   * routine while it stays open (raiseAttention keeps a single item per title), so a routine failing every half hour
   * is one line, not forty. Not told: a job only held for an HQ update (it runs right after), and, for routines
   * that report up the chain rather than to Phil, a pause he set himself or the plan's usage limit (HQ already says
   * when routines wait for the limit).
   */
  private async tellFailure(s: Schedule, agent: AgentDef, reason: string, tried: boolean): Promise<void> {
    if (/held until the HQ update/.test(reason)) return;
    if (!s.push && (!tried || isUsageLimit(reason))) return;
    const what = (REPORT_TITLE[s.id] ?? "").replace(/^[^:]*:\s*/, "") || s.id;
    const why = reason.replace(/\s+/g, " ").slice(0, 260);
    await this.jarvis.raiseAttention({
      agentId: agent.id,
      title: s.push ? `${agent.name}'s ${what} didn't run` : `${agent.name}'s routine failed: ${s.id}`,
      why: s.push ? `${why}. Ask ${agent.name} to run it again, or ask Einstein why.` : `${why}. It tries again on its next turn; if this keeps coming back, ask Einstein to look.`,
    });
  }
  /** When each routine last really started (wall clock), so one held for an update that a running tick started anyway isn't run twice. */
  private startedAt = new Map<string, number>();

  async tick(now = new Date()) {
    const phase = await this.jarvis.store.settings.get("phase", 0);
    // Last runs survive a restart, so a routine never runs twice in its window and the Schedules screen can show them.
    if (!this.loaded) { this.loaded = true; for (const [k, v] of Object.entries(await this.jarvis.store.settings.get<Record<string, number>>(LAST_RUN_KEY, {}))) if (!this.lastRun.has(k)) this.lastRun.set(k, v); }
    // Reports for the same lead from this tick are handed over together, so Munger gets one message from five scouts.
    const batches = new Map<string, RoutineReport[]>();
    const all = await this.allSchedules();
    const store = this.jarvis.store;
    // An approved update is waiting to restart HQ: start nothing, or the update would wait for it too. What comes due
    // is noted, not marked as run (a daily routine's ten-minute window may be gone by then), and runs after the update.
    const hold = async (ids: string[]) => {
      const fresh = await addDeferred(store, ids, now.getTime());
      if (fresh.length) await this.jarvis.router.log("jarvis", "schedule", `Scheduled: ${fresh.join(", ")} · waiting for the HQ update to go in; ${fresh.length === 1 ? "it runs" : "they run"} right after`);
    };
    if (await deployPending(store, now.getTime())) { await hold(this.due(now, phase, all).map((s) => s.id)); return; }
    // Held for the update: run now, unless it already ran since it was held (a tick that was going when the update was
    // approved may have run it).
    const deferred = new Set((await readDeferred(store)).filter((d) => !(d.at > 0 && (this.startedAt.get(d.id) ?? 0) >= d.at)).map((d) => d.id));
    await store.settings.set(DEFERRED_KEY, []);
    const heldReports = await store.settings.get<{ toId: string; reports: { agentId: string; scheduleId: string; text: string; runId: string }[] }[]>(HELD_REPORTS_KEY, []);
    if (heldReports.length) {
      await store.settings.set(HELD_REPORTS_KEY, []);
      for (const h of heldReports) batches.set(h.toId, [...(batches.get(h.toId) ?? []), ...h.reports.flatMap((r) => { const agent = getAgent(r.agentId); return agent ? [{ agent, scheduleId: r.scheduleId, text: r.text, runId: r.runId }] : []; })]);
    }
    // No update waiting: a workshop job held for one that never restarted HQ starts now (after a restart, boot does it).
    void this.jarvis.resumeHeldJobs().catch((e) => console.warn("[workshop] held jobs:", (e as Error).message));
    const dueNow = new Set(this.due(now, phase, all).map((s) => s.id));
    const list = all.filter((x) => dueNow.has(x.id) || (deferred.has(x.id) && x.phase <= phase));
    for (const [i, s] of list.entries()) {
      // An update approved while this tick was going: the rest waits for it too (each routine run would hold it up).
      if (await deployPending(store, now.getTime())) { await hold(list.slice(i).filter((x) => !this.running.has(x.id)).map((x) => x.id)); break; }
      // A long routine can span ticks: skip what's still running, and re-check since the snapshot was taken.
      if (this.running.has(s.id) || (!deferred.has(s.id) && !this.due(now, phase, [s]).length)) continue;
      if ((this.lastRun.get(s.id) ?? 0) < now.getTime()) this.lastRun.set(s.id, now.getTime());
      this.startedAt.set(s.id, Date.now());
      await this.jarvis.store.settings.set(LAST_RUN_KEY, Object.fromEntries(this.lastRun));
      const agent = getAgent(s.agentId);
      if (!agent) continue;
      this.running.add(s.id);
      // The log gets a schedule line only once the run did something Phil can see; a skipped or blocked timer stays out of it.
      const done = (what: string, runId?: string) => this.jarvis.router.log(agent.id, "schedule", `Scheduled: ${s.id} · ${what}`, runId);
      try {
        if (s.task === "brief") {
          const text = await this.jarvis.brief();
          await this.jarvis.say({ role: "jarvis", text: `Daily brief\n\n${text}` });
          bus.emitEvent({ type: "brief", text, at: new Date().toISOString() });
          bus.emitEvent({ type: "report", agentId: "jarvis", title: "Daily brief", text, at: new Date().toISOString() });
          await done("daily brief sent");
        } else if (s.task === "setup-check") {
          await done(await this.jarvis.syncSetupGoal());
        } else if (s.task === "connections-watch") {
          const r = await this.jarvis.watchConnections();
          if (r) await done(r);
        } else if (s.task === "goal-check") {
          // Logged only when a tick moved: an hourly "nothing changed" line would bury the log.
          const r = await this.jarvis.syncGoalChecks();
          if (r.changed) await done(r.summary);
        } else if (s.task === "backup" || s.task === "update-check") {
          const fn = this.jarvis.tasks.get(s.task);
          if (fn) { const r = await fn(); await done(r); }
        } else if (s.task === "condense") {
          // Nothing remembered or changed since the last tidy: there is nothing to tidy.
          const q = await this.jarvis.quiet(`schedule:${s.id}`, agent.id, ["memory"]);
          if (!q.skip && (await this.jarvis.store.memory.list()).length >= 20) {
            const text = await this.jarvis.condenseMemory();
            await this.jarvis.say({ role: "system", text });
            await q.ran();
            await done(text.split("\n")[0]!.slice(0, 120));
          }
        } else {
          // A routine that watches its sources isn't run when they hold nothing new: no model call, one log line.
          const q = s.watch?.length ? await this.jarvis.quiet(`schedule:${s.id}`, agent.id, s.watch) : undefined;
          if (q?.skip) { await this.jarvis.router.log(agent.id, "schedule", `Scheduled: ${s.id} · skipped, ${q.skip}`); continue; }
          const r = await runRoutine(this.jarvis, s, { deliver: false });
          // Phil is told when scheduled work didn't happen (Nov 23: "if an agent failed ... it would notify me, right?"):
          // a deliverable he is waiting on that didn't run for any reason, a deck routine that made no deck, and any
          // routine that was tried and failed.
          if (r?.blocked) await this.tellFailure(s, agent, r.blocked, !!r.failed);
          else if (r && s.deck && !("decks" in r && r.decks?.length)) await this.tellFailure(s, agent, "it ran, but no deck came out of it; its message says why", true);
          if (r && !r.blocked) {
            await q?.ran();
            await done(`${agent.name} reported back`, r.runId);
            if ("report" in r && r.report) batches.set(r.toId, [...(batches.get(r.toId) ?? []), r.report]);
          }
        }
      } catch (e) {
        await this.jarvis.router.log(agent.id, "error", `Schedule ${s.id} failed: ${(e as Error).message}`);
        await this.tellFailure(s, agent, (e as Error).message, true).catch(() => undefined);
      } finally { this.running.delete(s.id); }
    }
    // Handing reports to a lead starts the lead's run: while an update waits, they're kept and handed over after it.
    if (batches.size && await deployPending(store, now.getTime())) {
      const kept = await store.settings.get<{ toId: string; reports: { agentId: string; scheduleId: string; text: string; runId: string }[] }[]>(HELD_REPORTS_KEY, []);
      await store.settings.set(HELD_REPORTS_KEY, [...kept, ...[...batches].map(([toId, rs]) => ({ toId, reports: rs.map((r) => ({ agentId: r.agent.id, scheduleId: r.scheduleId, text: r.text, runId: r.runId })) }))]);
      batches.clear();
    }
    for (const [toId, reports] of batches) {
      try { await deliverReports(this.jarvis, toId, reports); } catch (e) { await this.jarvis.router.log(toId === "jarvis" ? "jarvis" : toId, "error", `Handing over ${reports.length} report(s) failed: ${(e as Error).message}`); }
    }
    bus.emitEvent({ type: "system", status: await this.jarvis.systemStatus() });
  }
}
