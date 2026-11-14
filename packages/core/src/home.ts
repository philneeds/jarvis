/**
 * The home screen's "Now" strip and agent picker, as plain functions so they can be tested here and imported by
 * HQ's browser code without pulling in the rest of core (no imports beyond types; exported as "@jarvis/core/home").
 */

/** What the home screen needs to know about an agent (a subset of HQ's live agent). */
export interface HomeAgent {
  id: string;
  name: string;
  short?: string;
  layer: number;
  venture: string;
  live: boolean;
  status: string;
  detail?: string;
  lastRunAt?: string;
}
export interface HomeApproval { id: string; agentId: string; title: string; at?: string }
export interface HomeAttention { id: string; agentId: string; title: string; status: string; at: string }
export interface HomeActivity { id: string; at: string; agentId: string; kind: string; summary: string; runId?: string; detail?: Record<string, unknown> }

/** An agent counts as active on home if it is live and has run in this many days (or is busy right now). */
export const ACTIVE_DAYS = 7;
const DAY = 86_400_000;

/** Live, and has run in the last seven days (working or waiting on Phil counts too). */
export function isActive(a: HomeAgent, now = Date.now()): boolean {
  if (!a.live) return false;
  if (a.status === "working" || a.status === "waiting") return true;
  const t = a.lastRunAt ? Date.parse(a.lastRunAt) : NaN;
  return Number.isFinite(t) && now - t <= ACTIVE_DAYS * DAY;
}

/** Markdown and line breaks out, first real line kept, cut at a word: one line for a strip. */
export function oneLine(text: string, max = 110): string {
  const raw = text.replace(/```[\s\S]*?```/g, " ").split(/\n+/).filter((l) => l.trim());
  // A heading on top ("## Calendar") says less than the sentence under it.
  if (raw.length > 1 && /^\s*#{1,6}\s/.test(raw[0]!)) raw.shift();
  const lines = raw
    .map((l) => l.replace(/^#{1,6}\s+/, "").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim())
    .filter((l) => l && !/^[-=_*]{3,}$/.test(l));
  const t = lines[0] ?? "";
  return t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

export interface PickerGroup { label: string; agents: HomeAgent[] }

/**
 * Who Phil can address from the command line: Jarvis first (the default), then the leads, then the rest of the
 * team. Only active agents (live, ran in the last seven days); everyone else stays in the Agent Web.
 */
export function pickerGroups(agents: HomeAgent[], now = Date.now()): PickerGroup[] {
  const byName = (a: HomeAgent, b: HomeAgent) => a.name.localeCompare(b.name);
  const shown = agents.filter((a) => a.id !== "jarvis" && isActive(a, now));
  const leads = shown.filter((a) => a.layer === 1).sort(byName);
  const team = shown.filter((a) => a.layer !== 1).sort((a, b) => a.layer - b.layer || byName(a, b));
  return [{ label: "Leads", agents: leads }, { label: "Team", agents: team }].filter((g) => g.agents.length);
}

/** The agent a command line is addressed to: the leading @name, or Jarvis. */
export function addressee(text: string): string {
  const m = /^@([\w.-]+)/.exec(text.trimStart());
  return m ? m[1]!.toLowerCase() : "jarvis";
}

/** The command line readdressed to an agent: any leading @name swapped for this one (Jarvis means none). */
export function readdress(text: string, agentId: string): string {
  const rest = text.trimStart().replace(/^@[\w.-]+\s*/, "");
  return agentId === "jarvis" ? rest : `@${agentId} ${rest}`;
}

export interface NowLine { agentId: string; name: string; venture: string; line: string; at?: string; count?: number; href: string }
export interface NowStrip { working: NowLine[]; waiting: NowLine[]; finished: NowLine[] }

/** The line a finished run leaves: its report or output, else the summary without the model and timing. */
function finishedLine(e: HomeActivity): string {
  const d = e.detail ?? {};
  const text = typeof d.report === "string" && d.report ? d.report : typeof d.output === "string" && d.output ? d.output : "";
  if (text) return oneLine(text);
  if (/ ran on .+ in [\d.]+s$/.test(e.summary)) return "Finished a run.";
  return oneLine(e.summary.replace(/^[^:]{1,80}?:\s+/, ""));
}

/**
 * Who is working on what, who is waiting on Phil, and the last few things that finished. Waiting groups an agent's
 * approvals and open to-dos into one line (newest first, with a count). Finished takes run lines, one per run.
 */
export function nowStrip(input: { agents: HomeAgent[]; pending: HomeApproval[]; attention: HomeAttention[]; activity: HomeActivity[]; finished?: number }): NowStrip {
  const { agents, pending, attention, activity, finished: keep = 3 } = input;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const who = (id: string) => byId.get(id) ?? { id, name: id, venture: "root" };

  const working = agents.filter((a) => a.status === "working").map((a) => ({ agentId: a.id, name: a.name, venture: a.venture, line: oneLine(a.detail || "") || "On it.", href: `/agents/${a.id}` }));

  const asks = new Map<string, { title: string; at: string; count: number; approve: number }>();
  const add = (agentId: string, title: string, at: string, approve: boolean) => {
    const cur = asks.get(agentId);
    if (!cur) { asks.set(agentId, { title, at, count: 1, approve: approve ? 1 : 0 }); return; }
    cur.count++; if (approve) cur.approve++;
    if (at > cur.at) { cur.title = title; cur.at = at; }
  };
  for (const p of pending) add(p.agentId, p.title, p.at ?? "", true);
  for (const i of attention) if (i.status === "open") add(i.agentId, i.title, i.at, false);
  for (const a of agents) if (a.status === "waiting" && !asks.has(a.id)) asks.set(a.id, { title: a.detail || "Waiting on you.", at: "", count: 0, approve: 0 });
  const waiting = [...asks.entries()]
    .sort((a, b) => (b[1].at > a[1].at ? 1 : b[1].at < a[1].at ? -1 : 0))
    .map(([id, w]) => { const a = who(id); return { agentId: id, name: a.name, venture: a.venture, line: oneLine(w.title), ...(w.at ? { at: w.at } : {}), ...(w.count > 1 ? { count: w.count } : {}), href: w.approve ? "/attention#approve" : "/attention#todo" }; });

  const seen = new Set<string>();
  const done: NowLine[] = [];
  for (const e of [...activity].filter((x) => x.kind === "run").sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) {
    const key = e.runId ?? e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = who(e.agentId);
    done.push({ agentId: e.agentId, name: a.name, venture: a.venture, line: finishedLine(e), at: e.at, href: `/agents/${e.agentId}` });
    if (done.length >= keep) break;
  }
  return { working, waiting, finished: done };
}
