"use client";

import { useEffect, useState } from "react";
import { api, post, fmtTime } from "@/lib/api";

type State = "ok" | "failed" | "off" | "unchecked";
interface Row { id: string; name: string; what?: string; state?: State; summary?: string; at?: string }

const ORDER: Record<string, number> = { failed: 0, ok: 1, unchecked: 2, never: 3, off: 4 };
const DOT: Record<string, string> = { ok: "dot-working", failed: "dot-error", unchecked: "dot-waiting", off: "dot-idle", never: "dot-idle" };

/**
 * Settings › Connections check: one press makes a real, read-only call to every connection and says which work,
 * which don't and why (Phil, Nov 24: finding the Robinhood fault took three rounds of screenshots). Each connection
 * is asked on its own, so the quick ones answer at once and a slow one (LeadPerfection signs in through a browser)
 * doesn't hold up the rest. What was last seen stays on the page between visits.
 */
export function ConnectionsCheck({ onChecked }: { onChecked?: () => void }) {
  const [rows, setRows] = useState<Row[]>();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string>();
  useEffect(() => { api<{ results: Row[] }>("/api/connectors/check").then((r) => setRows(r.results)).catch((e) => setErr((e as Error).message)); }, []);

  const check = async (ids: string[]) => {
    setErr(undefined);
    setBusy((b) => new Set([...b, ...ids]));
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await post<{ results: Row[] }>("/api/connectors/check", { only: [id] });
        const mine = r.results.find((x) => x.id === id);
        if (mine) setRows((was) => was?.map((x) => (x.id === id ? mine : x)));
      } catch (e) {
        // The check itself couldn't be run (HQ restarting, the page signed out): said on the row, not as a verdict on the service.
        setRows((was) => was?.map((x) => (x.id === id ? { ...x, state: "unchecked", summary: `HQ couldn't run this check (${(e as Error).message}). Try again.`, at: new Date().toISOString() } : x)));
      } finally { setBusy((b) => { const n = new Set(b); n.delete(id); return n; }); }
    }));
    onChecked?.();
  };

  const list = [...(rows ?? [])].sort((a, b) => ORDER[a.state ?? "never"]! - ORDER[b.state ?? "never"]!);
  const live = list.filter((r) => r.state !== "off"), off = list.filter((r) => r.state === "off");
  const n = (s: State) => list.filter((r) => r.state === s).length;
  const last = list.map((r) => r.at).filter(Boolean).sort().pop();
  const never = !!rows && !last;
  const first = (s?: string) => (s ?? "").split("\n")[0] ?? "";

  return (
    <section className="card flex flex-col gap-3" aria-label="Connections check">
      <div className="flex flex-wrap items-center gap-3">
        <span className="label">Connections check</span>
        <span className="text-[12px] flex-1 basis-48 min-w-0" style={{ color: "var(--muted)" }}>
          {!rows ? (err ?? "Loading…")
            : busy.size ? `Checking ${busy.size}…`
            : never ? "Not checked yet. One press asks every service for real; nothing is sent or changed."
            : <>{n("ok")} working{n("failed") ? <> · <b style={{ color: "var(--red)" }}>{n("failed")} not working</b></> : " · none failing"}{off.length ? ` · ${off.length} not set up` : ""}{last ? ` · last checked ${fmtTime(last)}` : ""}</>}
        </span>
        <button className="btn btn-sm btn-primary" disabled={!rows || busy.size > 0} onClick={() => void check((rows ?? []).map((r) => r.id))}>{busy.size ? "Checking…" : "Check everything"}</button>
      </div>
      {rows && err && <p className="m-0 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
      {live.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-col gap-2 text-[12px]">
          {live.map((r) => {
            const s = r.state ?? "never", more = (r.summary ?? "").includes("\n"), shown = s === "failed" || open.has(r.id);
            return (
              <li key={r.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className={`dot shrink-0 ${busy.has(r.id) ? "dot-waiting" : DOT[s]}`} />
                  <span className="flex-1 min-w-0"><b>{r.name}</b>{r.what ? <span style={{ color: "var(--muted)" }}> · {r.what}</span> : null}</span>
                  <button className="btn btn-sm shrink-0" disabled={busy.has(r.id)} onClick={() => void check([r.id])} aria-label={`Check ${r.name}`}>{busy.has(r.id) ? "…" : "Check"}</button>
                </div>
                {busy.has(r.id) ? <p className="m-0 pl-5" style={{ color: "var(--muted)" }}>Asking…</p>
                  : s === "never" ? null
                  : (
                    <p className="m-0 pl-5 whitespace-pre-wrap break-words" style={{ color: s === "failed" ? "var(--red)" : s === "ok" ? "var(--ink)" : "var(--muted)" }}>
                      {s === "failed" ? <b>Not working: </b> : null}{shown ? r.summary : first(r.summary)}
                      {more && s !== "failed" ? <> <button className="underline bg-transparent border-0 p-0 cursor-pointer" style={{ color: "var(--muted)" }} onClick={() => setOpen((o) => { const x = new Set(o); if (x.has(r.id)) x.delete(r.id); else x.add(r.id); return x; })}>{shown ? "less" : "more"}</button></> : null}
                    </p>
                  )}
              </li>
            );
          })}
        </ul>
      )}
      {off.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer" style={{ color: "var(--muted)" }}>Not set up ({off.length}): {off.map((r) => r.name).join(", ")}</summary>
          <ul className="m-0 mt-2 p-0 list-none flex flex-col gap-1.5">
            {off.map((r) => <li key={r.id} className="flex items-start gap-2"><span className="dot dot-idle shrink-0 mt-1" /><span style={{ color: "var(--muted)" }}><b style={{ color: "var(--ink)" }}>{r.name}</b>{r.what ? ` · ${r.what}` : ""}. {r.summary}</span></li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
