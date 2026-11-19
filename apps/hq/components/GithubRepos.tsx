"use client";

import { useEffect, useMemo, useState } from "react";
import { api, put } from "@/lib/api";

interface Repo { name: string; description: string; private: boolean; language: string; pushed: string }
interface Agent { id: string; name: string; venture: string }
interface Data { repos: Repo[]; access: Record<string, string[]>; agents: Agent[] }

/**
 * Settings › GitHub: every repo the GitHub key reads, and which agents may read each one. Once any repo is assigned,
 * each agent reads only its own (HQ enforces it on every GitHub call), and an agent given a repo gets the read tools.
 */
export function GithubRepos() {
  const [data, setData] = useState<Data>();
  const [err, setErr] = useState<string>();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string>();
  useEffect(() => { api<Data>("/api/github/repos").then(setData).catch((e) => setErr((e as Error).message)); }, []);

  const name = useMemo(() => new Map((data?.agents ?? []).map((a) => [a.id, a.name])), [data]);
  if (err) return <p className="m-0 pl-6" style={{ color: "var(--red)" }}>{err}</p>;
  if (!data) return <p className="m-0 pl-6" style={{ color: "var(--muted)" }}>Loading repos…</p>;

  const assigned = Object.keys(data.access).length > 0;
  const shown = data.repos.filter((r) => !q || `${r.name} ${r.description}`.toLowerCase().includes(q.toLowerCase()));
  const save = async (repo: string, agents: string[]) => {
    setBusy(repo); setErr(undefined);
    try { const r = await put<{ access: Record<string, string[]> }>("/api/github/access", { repo, agents }); setData({ ...data, access: r.access }); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(undefined); }
  };

  return (
    <div className="flex flex-col gap-2 pl-6">
      <p className="m-0" style={{ color: "var(--muted)" }}>
        {assigned
          ? "Each agent reads only the repos assigned to it here. Giving an agent a repo also gives it the GitHub read tools. Nothing in GitHub changes."
          : "Nothing assigned yet, so the agents with GitHub in their job (Jason, the dev team, Paul, Ansem) read every repo below. Assign one and each agent reads only its own."}
      </p>
      {data.repos.length > 8 && <input className="input h-8" placeholder="Find a repo" aria-label="Find a repo" value={q} onChange={(e) => setQ(e.target.value)} />}
      {!data.repos.length && <p className="m-0" style={{ color: "var(--muted)" }}>The key reads no repos yet. In GitHub, give the token access to your repos (All repositories, read-only, picks up new projects on its own).</p>}
      <ul className="m-0 p-0 list-none flex flex-col">
        {shown.map((r) => {
          const ids = data.access[r.name.toLowerCase()] ?? [];
          const free = data.agents.filter((a) => !ids.includes(a.id));
          return (
            <li key={r.name} className="flex flex-wrap items-center gap-2 py-1.5 border-t" style={{ borderColor: "var(--line)", opacity: busy === r.name ? 0.6 : 1 }}>
              <span className="min-w-0 flex-1 basis-56">
                <b style={{ color: "var(--ink-bright)" }}>{r.name}</b>
                <span style={{ color: "var(--dim)" }}>{r.private ? " · private" : ""}{r.language ? ` · ${r.language}` : ""}</span>
                {r.description && <span className="block truncate" style={{ color: "var(--muted)" }}>{r.description}</span>}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {ids.length === 0 && <span style={{ color: "var(--dim)" }}>{assigned ? "no agent" : "everyone with GitHub"}</span>}
                {ids.map((id) => (
                  <span key={id} className="base-chip normal-case tracking-normal text-[11px] flex items-center gap-1">
                    {id === "*" ? "Everyone with GitHub" : name.get(id) ?? id}
                    <button aria-label={`Take ${r.name} from ${id === "*" ? "everyone" : name.get(id) ?? id}`} disabled={!!busy} onClick={() => void save(r.name, ids.filter((x) => x !== id))} style={{ color: "var(--muted)" }}>×</button>
                  </span>
                ))}
                <select className="input h-7 w-auto text-[11px]" aria-label={`Give ${r.name} to an agent`} value="" disabled={!!busy} onChange={(e) => { if (e.target.value) void save(r.name, [...ids, e.target.value]); }}>
                  <option value="">+ agent</option>
                  {!ids.includes("*") && <option value="*">Everyone with GitHub</option>}
                  {free.filter((a) => a.id !== "*").sort((a, b) => a.name.localeCompare(b.name)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
