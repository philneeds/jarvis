import type { VentureId } from "../registry/ventures.js";

/** What each venture's dashboard tracks. Agents fill it with metric/record blocks; Phil edits by hand. */
export interface MetricDef { key: string; label: string; unit?: "$" | "%" | "n" | "h"; good?: "up" | "down" }
export interface RecordKindDef { kind: string; label: string; statuses: string[]; fields: { key: string; label: string; type?: "text" | "number" | "date" | "money" }[] }
export interface VentureDash { metrics: MetricDef[]; records: RecordKindDef[]; blurb: string }

export const VENTURE_DASH: Record<VentureId, VentureDash> = {
  root: { blurb: "Jarvis.", metrics: [], records: [] },
  command: {
    blurb: "The command center: Jarvis, HQ, tooling and memory.",
    metrics: [{ key: "agent_runs", label: "Agent runs", unit: "n" }, { key: "approvals_decided", label: "Approvals decided", unit: "n" }],
    records: [{ kind: "upgrade", label: "Proposed upgrades (Einstein)", statuses: ["proposed", "approved", "done", "dropped"], fields: [{ key: "why", label: "Why" }, { key: "effort", label: "Effort" }] }],
  },
  personal: {
    blurb: "Lip, David and Doc's team: life, goals and health.",
    metrics: [{ key: "sleep_hours", label: "Sleep", unit: "h", good: "up" }, { key: "workouts_week", label: "Workouts / week", unit: "n", good: "up" }, { key: "weight_lb", label: "Weight", unit: "n" }, { key: "recovery", label: "Recovery", unit: "%", good: "up" }],
    records: [{ kind: "goal", label: "Goals (David)", statuses: ["set", "on track", "slipping", "done"], fields: [{ key: "by", label: "By", type: "date" }, { key: "next", label: "Next step" }] }],
  },
  money: {
    blurb: "Munger's books: net worth, cash flow, the stock portfolio and Mayne's on-chain fund.",
    metrics: [{ key: "net_worth", label: "Net worth", unit: "$", good: "up" }, { key: "cash", label: "Cash", unit: "$" }, { key: "portfolio_value", label: "Portfolio", unit: "$", good: "up" }, { key: "monthly_cash_flow", label: "Monthly cash flow", unit: "$", good: "up" }],
    records: [{ kind: "holding", label: "Holdings (Buffett)", statuses: ["hold", "add", "trim", "sell", "watch"], fields: [{ key: "sector", label: "Sector" }, { key: "qty", label: "Qty", type: "number" }, { key: "value", label: "Value", type: "money" }, { key: "thesis", label: "Thesis" }] }],
  },
  crypto: {
    blurb: "Mantis's desk: what the team is watching on-chain and what Mayne holds.",
    metrics: [{ key: "pnl_week", label: "P&L / week", unit: "$", good: "up" }, { key: "open_positions", label: "Open positions", unit: "n" }, { key: "funding_avg", label: "Avg funding", unit: "%" }],
    records: [{ kind: "watch", label: "Watchlist", statuses: ["watching", "entered", "exited", "dropped"], fields: [{ key: "symbol", label: "Symbol" }, { key: "thesis", label: "Thesis" }, { key: "scout", label: "Scout" }] }, { kind: "paper", label: "Paper tests (Mayne)", statuses: ["running", "won", "lost", "stopped"], fields: [{ key: "strategy", label: "Strategy" }, { key: "entry", label: "Entry" }, { key: "exit", label: "Exit" }, { key: "pnl", label: "P&L", type: "money" }] }],
  },
  philneeds: {
    blurb: "Nick's numbers for the Philneeds brand: Boo's posts and ncrypt's replies.",
    metrics: [{ key: "followers", label: "Followers", unit: "n", good: "up" }, { key: "impressions_week", label: "Impressions / week", unit: "n", good: "up" }, { key: "posts_week", label: "Posts / week", unit: "n" }, { key: "engagement", label: "Engagement", unit: "%", good: "up" }],
    records: [{ kind: "post", label: "Posts (Boo)", statuses: ["drafted", "approved", "posted", "winner", "dropped"], fields: [{ key: "account", label: "Account" }, { key: "url", label: "URL" }, { key: "likes", label: "Likes", type: "number" }] }],
  },
  acres: {
    blurb: "Jeff's Airdrop Acres: community growth and distribution.",
    metrics: [{ key: "members", label: "Members", unit: "n", good: "up" }, { key: "distributions", label: "Distributions", unit: "n" }, { key: "active_week", label: "Active / week", unit: "n", good: "up" }],
    records: [{ kind: "campaign", label: "Campaigns", statuses: ["planned", "live", "done"], fields: [{ key: "channel", label: "Channel" }, { key: "goal", label: "Goal" }] }],
  },
  range: {
    blurb: "Poseidon's Range.cool: users, revenue, runway and what Jason's team is shipping.",
    metrics: [{ key: "users", label: "Users", unit: "n", good: "up" }, { key: "mrr", label: "MRR", unit: "$", good: "up" }, { key: "burn", label: "Burn / month", unit: "$", good: "down" }, { key: "runway_months", label: "Runway", unit: "n", good: "up" }],
    records: [{ kind: "milestone", label: "Milestones (Jason)", statuses: ["planned", "building", "shipped", "blocked"], fields: [{ key: "owner", label: "Owner" }, { key: "by", label: "By", type: "date" }] }],
  },
  jdpm: {
    blurb: "Stella's board for JD PM Renovations: leads in, jobs sold, jobs on schedule, cash.",
    metrics: [{ key: "leads_week", label: "Leads / week", unit: "n", good: "up" }, { key: "jobs_sold_month", label: "Jobs sold / month", unit: "n", good: "up" }, { key: "revenue_month", label: "Revenue / month", unit: "$", good: "up" }, { key: "pipeline", label: "Pipeline", unit: "$", good: "up" }],
    records: [
      { kind: "lead", label: "Leads (Karol)", statuses: ["new", "contacted", "quoted", "won", "lost"], fields: [{ key: "phone", label: "Phone" }, { key: "source", label: "Source" }, { key: "value", label: "Value", type: "money" }, { key: "next", label: "Next step" }] },
      { kind: "job", label: "Jobs (Bill)", statuses: ["scheduled", "in progress", "done", "on hold"], fields: [{ key: "customer", label: "Customer" }, { key: "address", label: "Address" }, { key: "value", label: "Value", type: "money" }, { key: "start", label: "Start", type: "date" }] },
    ],
  },
  proedge: {
    blurb: "Stevon's ProEdge: sales, appointments and the team.",
    metrics: [{ key: "sales_week", label: "Sales / week", unit: "n", good: "up" }, { key: "appointments_week", label: "Appointments / week", unit: "n", good: "up" }, { key: "close_rate", label: "Close rate", unit: "%", good: "up" }, { key: "team_size", label: "Team", unit: "n" }],
    records: [{ kind: "rep", label: "Reps", statuses: ["ramping", "on quota", "behind", "left"], fields: [{ key: "quota", label: "Quota", type: "money" }, { key: "closed", label: "Closed", type: "money" }, { key: "coach_note", label: "Coach note" }] }],
  },
  lab: {
    blurb: "The Memecoin Analyzer pipeline: ideas to backtest to paper to Mantis's approval to Mayne.",
    metrics: [{ key: "strategies_backtested", label: "Backtested", unit: "n" }, { key: "live_strategies", label: "Live", unit: "n" }, { key: "paper_pnl", label: "Paper P&L", unit: "$", good: "up" }],
    records: [{ kind: "strategy", label: "Strategies (Ansem, Jason)", statuses: ["idea", "backtest", "paper", "mantis review", "approved", "live", "retired"], fields: [{ key: "backtestReturn", label: "Backtest return" }, { key: "winRate", label: "Win rate" }, { key: "maxDrawdown", label: "Max drawdown" }, { key: "paperDays", label: "Paper days", type: "number" }] }],
  },
};

export function dashFor(v: VentureId): VentureDash { return VENTURE_DASH[v]; }
export function metricDef(v: VentureId, key: string): MetricDef | undefined { return VENTURE_DASH[v]?.metrics.find((m) => m.key === key); }
export function recordKind(v: VentureId, kind: string): RecordKindDef | undefined { return VENTURE_DASH[v]?.records.find((r) => r.kind === kind); }
