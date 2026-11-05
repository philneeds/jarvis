"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api } from "@/lib/api";
import { MayneLimits } from "@/components/MayneLimits";
import type { AgentConfig, ApprovalKind, Charter, ModelKey } from "@jarvis/core";

const FIELDS: { key: keyof AgentConfig["persona"]; label: string; hint: string }[] = [
  { key: "reportsTo", label: "Reports to", hint: "Who this agent answers to, if not the registry default" },
  { key: "job", label: "Job in one sentence", hint: "" },
  { key: "daily", label: "What it does daily / on demand", hint: "" },
  { key: "tools", label: "Tools and accounts it needs", hint: "CRM, calendar, wallets, X account…" },
  { key: "alone", label: "What it may do alone vs. needs approval", hint: "" },
  { key: "approval", label: "Approval notes", hint: "Dollar thresholds, who to copy, what never goes out" },
  { key: "preferredAI", label: "Preferred AI (if any)", hint: "Only a note; the model switch below is what counts" },
  { key: "good", label: "What \"good\" looks like", hint: "" },
];
const KINDS: ApprovalKind[] = ["send", "post", "config", "record", "other"];

export default function AgentSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { state, refresh } = useLive();
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [googleAccounts, setGoogleAccounts] = useState<string[]>([]);
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);
  const agent = state?.agents.find((a) => a.id === id);
  const [registryDefault, setRegistryDefault] = useState<ModelKey | undefined>();
  const [charter, setCharter] = useState<Charter | null>(null);
  const [editBrief, setEditBrief] = useState(false);

  useEffect(() => {
    api<{ config: AgentConfig; tools: string[]; defaultModel: ModelKey; charter: Charter | null }>(`/api/agents/${id}/config`).then((r) => { setCfg(r.config); setToolNames(r.tools); setRegistryDefault(r.defaultModel); setCharter(r.charter); setEditBrief(Object.values(r.config.persona).some((v) => v && String(v).trim())); }).catch((e) => setSaved((e as Error).message));
    api<{ google: { accounts: { email: string }[] } }>("/api/connectors").then((r) => setGoogleAccounts(r.google.accounts.map((a) => a.email))).catch(() => undefined);
  }, [id]);

  const save = async () => {
    if (!cfg) return;
    setBusy(true); setSaved(undefined);
    try {
      const r = await api<{ config: AgentConfig }>(`/api/agents/${id}/config`, { method: "PUT", body: JSON.stringify(cfg) });
      setCfg(r.config); setSaved("Saved."); await refresh();
    } catch (e) { setSaved((e as Error).message); } finally { setBusy(false); }
  };

  if (!agent || !cfg) return <Shell><div className="p-6" style={{ color: "var(--muted)" }}>{saved ?? "Loading…"}</div></Shell>;
  const color = state?.ventures[agent.venture]?.color;
  const sched = cfg.schedule ?? { enabled: false, when: "", task: "" };

  return (
    <Shell>
      <div className="max-w-3xl w-full mx-auto p-4 flex flex-col gap-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Link href={`/web?agent=${id}`} className="text-[11px] tracking-[0.14em] uppercase">‹ Agent Web</Link>
          <h1 className="display font-bold text-3xl m-0" style={{ color: "var(--ink-bright)" }}>{agent.name}</h1>
          <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color }}>{agent.short} · {state?.ventures[agent.venture]?.label}</span>
        </div>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>{agent.desc}</p>

        {id === "mayne" && <MayneLimits />}

        {charter && (
          <section className="card flex flex-col gap-3" aria-label="Charter" style={{ borderColor: `color-mix(in srgb, ${color ?? "var(--accent)"} 55%, transparent)` }}>
            <span className="label">Charter</span>
            <p className="m-0 text-[15px] leading-snug" style={{ color: "var(--ink-bright)" }}>{charter.job}</p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Owns</span>
                <ul className="m-0 pl-4 text-[12px] leading-relaxed">{charter.owns.map((o) => <li key={o}>{o}</li>)}</ul>
              </div>
              {charter.handsOff && charter.handsOff.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Hands off</span>
                  <ul className="m-0 pl-4 text-[12px] leading-relaxed">{charter.handsOff.map(([w, to]) => <li key={w}>{w} → <Link href={`/agents/${to}`} style={{ color: state?.ventures[state.agents.find((a) => a.id === to)?.venture ?? "root"]?.color }}>{state?.agents.find((a) => a.id === to)?.name ?? to}</Link></li>)}</ul>
                </div>
              )}
            </div>
            <dl className="m-0 grid gap-x-4 gap-y-1 text-[12px]" style={{ gridTemplateColumns: "max-content 1fr" }}>
              <dt className="text-[10px] tracking-[0.14em] uppercase self-center" style={{ color: "var(--muted)" }}>Rhythm</dt><dd className="m-0">{charter.rhythm}</dd>
              <dt className="text-[10px] tracking-[0.14em] uppercase self-center" style={{ color: "var(--muted)" }}>Good looks like</dt><dd className="m-0">{charter.good}</dd>
            </dl>
            {charter.open && charter.open.length > 0 && (
              <div className="border-l-2 pl-3 flex flex-col gap-1" style={{ borderColor: "var(--amber)" }}>
                <span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--amber)" }}>Needs your answer</span>
                <ul className="m-0 pl-4 text-[12px] leading-relaxed">{charter.open.map((q) => <li key={q}>{q}</li>)}</ul>
              </div>
            )}
          </section>
        )}

        <section className="card flex flex-col gap-3" aria-label="Persona">
          <div className="flex items-center gap-3">
            <span className="label">Your changes to the charter</span>
            <button type="button" className="ml-auto text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--accent)" }} aria-expanded={editBrief} onClick={() => setEditBrief(!editBrief)}>{editBrief ? "Hide" : "Edit"}</button>
          </div>
          {!editBrief && <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>{Object.values(cfg.persona).some((v) => v && String(v).trim()) ? "You've changed parts of the charter. Edit to see them." : "None. The charter above is what this agent works from."}</p>}
          {editBrief && FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>
              {f.label}
              <textarea className="input py-2 h-16 normal-case tracking-normal text-[13px]" placeholder={(f.key === "job" ? charter?.job : f.key === "daily" ? charter?.rhythm : f.key === "good" ? charter?.good : undefined) ?? f.hint} value={cfg.persona[f.key] ?? ""} onChange={(e) => setCfg({ ...cfg, persona: { ...cfg.persona, [f.key]: e.target.value } })} />
            </label>
          ))}
        </section>

        <section className="card flex flex-col gap-3" aria-label="Model">
          <span className="label">Model</span>
          <select className="input h-10" value={cfg.model || agent.model || registryDefault} onChange={(e) => setCfg({ ...cfg, model: e.target.value as AgentConfig["model"] })} aria-label="Model">
            {state && Object.values(state.models).filter((m) => m.key !== "web-app").map((m) => <option key={m.key} value={m.key}>{m.label} — {m.why}</option>)}
          </select>
          <span className="text-[11px]" style={{ color: "var(--muted)" }}>Registry default: {registryDefault ? state?.models[registryDefault]?.label : "—"}. A swap takes effect on the next run.</span>
        </section>

        <section className="card flex flex-col gap-3" aria-label="Tools">
          <span className="label">Tools (read-only, Claude agents)</span>
          <div className="flex flex-wrap gap-2">
            {toolNames.map((t) => (
              <label key={t} className="btn btn-sm cursor-pointer" style={cfg.tools.includes(t) ? { borderColor: "var(--accent)", background: "rgba(60,130,255,0.25)" } : undefined}>
                <input type="checkbox" className="sr-only" checked={cfg.tools.includes(t)} onChange={(e) => setCfg({ ...cfg, tools: e.target.checked ? [...cfg.tools, t] : cfg.tools.filter((x) => x !== t) })} />
                {t}
              </label>
            ))}
          </div>
        </section>

        {googleAccounts.length > 0 && (
          <section className="card flex flex-col gap-3" aria-label="Google accounts">
            <span className="label">Google accounts this agent may use</span>
            <span className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing ticked = all connected accounts. Tick some to fence the agent in (Stella to the JD PM mailbox, say).</span>
            <div className="flex flex-wrap gap-2">
              {googleAccounts.map((e) => (
                <label key={e} className="btn btn-sm cursor-pointer normal-case tracking-normal" style={(cfg.accounts ?? []).includes(e) ? { borderColor: "var(--accent)", background: "rgba(60,130,255,0.25)" } : undefined}>
                  <input type="checkbox" className="sr-only" checked={(cfg.accounts ?? []).includes(e)} onChange={(ev) => setCfg({ ...cfg, accounts: ev.target.checked ? [...(cfg.accounts ?? []), e] : (cfg.accounts ?? []).filter((x) => x !== e) })} />
                  {e}
                </label>
              ))}
            </div>
          </section>
        )}

        <section className="card flex flex-col gap-3" aria-label="Schedule">
          <span className="label">Schedule</span>
          <div className="flex flex-wrap gap-2 items-center">
            <label className="btn btn-sm cursor-pointer" style={sched.enabled ? { borderColor: "var(--accent)", background: "rgba(60,130,255,0.25)" } : undefined}>
              <input type="checkbox" className="sr-only" checked={sched.enabled} onChange={(e) => setCfg({ ...cfg, schedule: { ...sched, enabled: e.target.checked } })} />{sched.enabled ? "On" : "Off"}
            </label>
            <input className="input h-9 w-40" placeholder="daily@07:00, weekdays@08:30, weekly:sun@04:00, monthly:1@08:00" aria-label="When" value={sched.when} onChange={(e) => setCfg({ ...cfg, schedule: { ...sched, when: e.target.value } })} />
          </div>
          <textarea className="input py-2 h-16" placeholder="What it does on that timer" aria-label="Scheduled task" value={sched.task} onChange={(e) => setCfg({ ...cfg, schedule: { ...sched, task: e.target.value } })} />
          <span className="text-[11px]" style={{ color: "var(--muted)" }}>Runs when there is room in the plan; scouts back off at 70%. Built-in schedules are on the Usage screen.</span>
        </section>

        <section className="card flex flex-col gap-3" aria-label="Approval rules">
          <span className="label label-amber">Approval rules</span>
          {charter?.asksFor === "everything" ? (
            <p className="m-0 text-[12px]">Your rule: {agent.name} brings you every action as an approval, and carries it out once you approve.</p>
          ) : charter?.asksFor === "outbound" ? (
            <p className="m-0 text-[12px]">Your rule: {agent.name} does internal work on her own (your own calendar events, archiving, labels, notes). Anything that reaches another person (email, replies, calendar changes with guests) and anything moved to Trash comes to you first.</p>
          ) : <>
          <span className="text-[12px]">Kinds this agent may do without you. Money and strategies always wait, whatever you tick.</span>
          <div className="flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <label key={k} className="btn btn-sm cursor-pointer" style={cfg.rules.autoApprove.includes(k) ? { borderColor: "var(--amber)", background: "rgba(255,194,102,0.18)" } : undefined}>
                <input type="checkbox" className="sr-only" checked={cfg.rules.autoApprove.includes(k)} onChange={(e) => setCfg({ ...cfg, rules: { ...cfg.rules, autoApprove: e.target.checked ? [...cfg.rules.autoApprove, k] : cfg.rules.autoApprove.filter((x) => x !== k) } })} />{k}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-3 text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>
              Auto up to $<input className="input h-9 w-32" type="number" min={0} value={cfg.rules.maxAutoDollars} onChange={(e) => setCfg({ ...cfg, rules: { ...cfg.rules, maxAutoDollars: Number(e.target.value) } })} aria-label="Dollar cap for automatic approval" />
            </label>
            <label className="flex items-center gap-3 text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>
              Auto up to <input className="input h-9 w-28" type="number" min={0} value={cfg.rules.maxAutoItems ?? 100} onChange={(e) => setCfg({ ...cfg, rules: { ...cfg.rules, maxAutoItems: Number(e.target.value) } })} aria-label="Item cap for automatic bulk actions" /> items
            </label>
          </div>
          </>}
        </section>

        <div className="flex items-center gap-3">
          <button className="btn btn-primary" disabled={busy} onClick={save}>Save settings</button>
          {saved && <span className="text-[12px]" style={{ color: saved === "Saved." ? "var(--green)" : "var(--red)" }}>{saved}</span>}
        </div>
      </div>
    </Shell>
  );
}
