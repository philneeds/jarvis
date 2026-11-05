"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { api, post, timeAgo } from "@/lib/api";
import { useUndo } from "@/lib/undo";

interface Item { scope: string; key: string; value: string; source?: string; updatedAt: string }

export default function MemoryPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [add, setAdd] = useState({ scope: "phil", key: "", value: "" });
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const showUndo = useUndo();

  const load = () => api<{ items: Item[] }>("/api/memory").then((r) => setItems(r.items)).catch((e) => setMsg((e as Error).message));
  useEffect(() => { void load(); }, []);

  const save = async (scope: string, key: string, value: string) => {
    await api("/api/memory", { method: "PUT", body: JSON.stringify({ scope, key, value }) });
    setEdit(null); await load();
  };
  const remove = async (scope: string, key: string) => {
    try {
      const r = await api<{ undoId: string }>(`/api/memory?scope=${encodeURIComponent(scope)}&key=${encodeURIComponent(key)}`, { method: "DELETE" });
      await load();
      showUndo(`Forgot [${scope}] ${key}`, r.undoId, () => void load());
    } catch (e) { setMsg((e as Error).message); }
  };
  const condense = async () => {
    setBusy(true); setMsg(undefined);
    try { setMsg((await post<{ message: string }>("/api/memory/condense")).message); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  // Every word must appear somewhere in the scope, key or value.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((i) => { const hay = `${i.scope}\n${i.key}\n${i.value}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  const scopes = [...new Set(shown.map((i) => i.scope))].sort();

  return (
    <Shell>
      <div className="max-w-3xl w-full mx-auto p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>MEMORY</h1>
          <span className="text-[12px]" style={{ color: "var(--muted)" }} aria-live="polite">{words.length ? `${shown.length} of ${items.length} items` : `${items.length} items`}</span>
          <span className="flex gap-1 w-full sm:w-auto order-last sm:order-none">
            <input type="search" className="input h-9 flex-1 sm:w-64" placeholder="Search key, value or scope" aria-label="Search memory by key, value or scope" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }} />
            {q && <button className="btn btn-sm h-9" onClick={() => setQ("")}>Clear</button>}
          </span>
          <button className="btn btn-sm ml-auto" disabled={busy} onClick={condense}>Condense (Oscar)</button>
        </div>
        <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>What the web knows about you, your ventures and contacts. Agents read this before they act. Correct anything here; Oscar&apos;s condensing waits for your approval.</p>
        {msg && <p className="m-0 text-[12px]" style={{ color: "var(--amber)" }}>{msg}</p>}

        <form className="card flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); if (add.key && add.value) void save(add.scope, add.key, add.value).then(() => setAdd({ scope: add.scope, key: "", value: "" })); }}>
          <label className="flex flex-col gap-1 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>Scope<input className="input h-9 w-40" value={add.scope} onChange={(e) => setAdd({ ...add, scope: e.target.value })} placeholder="phil · venture:jdpm · contact:Smith" /></label>
          <label className="flex flex-col gap-1 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>Key<input className="input h-9 w-40" value={add.key} onChange={(e) => setAdd({ ...add, key: e.target.value })} /></label>
          <label className="flex flex-col gap-1 flex-1 min-w-48 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>Value<input className="input h-9" value={add.value} onChange={(e) => setAdd({ ...add, value: e.target.value })} /></label>
          <button className="btn btn-sm btn-primary h-9" disabled={!add.key || !add.value}>Remember</button>
        </form>

        {scopes.length === 0 && items.length > 0 && <div className="card text-center py-6" style={{ color: "var(--muted)" }}>Nothing matches &ldquo;{q.trim()}&rdquo;.</div>}
        {items.length === 0 && <div className="card text-center py-10" style={{ color: "var(--muted)" }}>Nothing on file yet. Agents add to this as they work; so can you.</div>}
        {scopes.map((scope) => (
          <section key={scope} className="card flex flex-col gap-2" aria-label={scope}>
            <span className="label">{scope}</span>
            {shown.filter((i) => i.scope === scope).map((i) => {
              const id = `${i.scope}:${i.key}`;
              return (
                <div key={id} className="flex flex-col gap-1 py-2 border-t" style={{ borderColor: "rgba(124,196,255,0.12)" }}>
                  <div className="flex items-baseline gap-3 text-[11px]"><b className="tracking-[0.08em]" style={{ color: "var(--ink-strong)" }}>{i.key}</b><span style={{ color: "var(--dim)" }}>{i.source ? `by ${i.source} · ` : ""}{timeAgo(i.updatedAt)}</span>
                    <span className="ml-auto flex gap-1.5">
                      {edit === id ? <><button className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-sm btn-primary" onClick={() => save(i.scope, i.key, draft)}>Save</button></> : <><button className="btn btn-sm" onClick={() => { setEdit(id); setDraft(i.value); }}>Edit</button><button className="btn btn-sm btn-danger" onClick={() => remove(i.scope, i.key)}>Forget</button></>}
                    </span>
                  </div>
                  {edit === id ? <textarea className="input py-2 h-20" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Edit ${i.key}`} /> : <p className="m-0 text-[13px] whitespace-pre-wrap">{i.value}</p>}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </Shell>
  );
}
