"use client";

import { useEffect, useState } from "react";
import { api, post, timeAgo } from "@/lib/api";
import type { TradingLimits, Ledger } from "@jarvis/core";

interface Trading { limits: TradingLimits; ledger: Ledger; strategies: { name: string; enabledAt: string }[] }

/** Mayne's hard limits: position size, daily loss, open positions, auto-stop. Apply even after approval. */
export function MayneLimits({ compact }: { compact?: boolean }) {
  const [t, setT] = useState<Trading | null>(null);
  const [draft, setDraft] = useState<TradingLimits | null>(null);
  const [equity, setEquity] = useState("");
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = () => api<Trading>("/api/trading").then((r) => { setT(r); setDraft(r.limits); }).catch((e) => setMsg((e as Error).message));
  useEffect(() => { void load(); }, []);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setMsg(undefined); try { await fn(); await load(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };

  if (!t || !draft) return <div className="card" style={{ color: "var(--muted)" }}>{msg ?? "Loading Mayne's limits…"}</div>;
  const led = t.ledger;
  const num = (k: keyof TradingLimits, label: string, unit: string) => (
    <label className="flex flex-col gap-1 text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--muted)" }}>
      {label}
      <span className="flex items-center gap-1"><span style={{ color: "var(--gold)" }}>{unit === "$" ? "$" : ""}</span><input className="input h-9 w-28" type="number" min={0} value={draft[k] as number} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} aria-label={label} />{unit === "%" ? "%" : ""}</span>
    </label>
  );

  if (compact) {
    return (
      <div className="border p-2 text-[12px] flex flex-col gap-1" style={{ borderColor: "rgba(242,193,78,0.4)" }}>
        <span className="label" style={{ color: "var(--gold)" }}>Mayne&apos;s hard limits {t.limits.enabled ? "" : "(OFF)"}</span>
        <span>Max position ${t.limits.maxPositionUsd} · Max daily loss ${t.limits.maxDailyLossUsd} · Max open {t.limits.maxOpenPositions} · Auto-stop at {t.limits.autoStopDrawdownPct}% drawdown. They apply after approval too.</span>
        {led.stoppedAt && <span style={{ color: "var(--red)" }}>AUTO-STOP ON: {led.stopReason}</span>}
      </div>
    );
  }

  return (
    <section className="card flex flex-col gap-4" aria-label="Mayne's hard limits">
      <div className="flex items-center gap-3">
        <span className="label" style={{ color: "var(--gold)" }}>Mayne&apos;s hard limits</span>
        <label className="btn btn-sm cursor-pointer ml-auto" style={draft.enabled ? { borderColor: "var(--gold)", background: "rgba(255,194,102,0.18)" } : undefined}>
          <input type="checkbox" className="sr-only" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />{draft.enabled ? "Limits on" : "Limits OFF"}
        </label>
      </div>
      <p className="m-0 text-[12px]">Checked when Mayne asks, and again when an approved trade executes. A breach of the daily loss or the drawdown stop pauses all trading until you clear it.</p>
      <div className="flex flex-wrap gap-4">
        {num("maxPositionUsd", "Max position", "$")}
        {num("maxDailyLossUsd", "Max daily loss", "$")}
        {num("maxOpenPositions", "Max open positions", "")}
        {num("autoStopDrawdownPct", "Auto-stop drawdown", "%")}
      </div>
      <div className="flex items-center gap-3">
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api("/api/trading/limits", { method: "PUT", body: JSON.stringify(draft) }))}>Save limits</button>
        {msg && <span className="text-[12px]" style={{ color: "var(--red)" }}>{msg}</span>}
      </div>

      <div className="border-t pt-3 flex flex-col gap-2" style={{ borderColor: "var(--line)" }}>
        <span className="label">Today · {led.day}</span>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
          <span>Realized P&amp;L <b style={{ color: led.realizedPnlUsd < 0 ? "var(--red)" : "var(--green)" }}>${led.realizedPnlUsd.toFixed(2)}</b></span>
          <span>Open <b>{led.open.length}</b> / {t.limits.maxOpenPositions}</span>
          {led.equityUsd !== undefined && <span>Equity <b>${led.equityUsd.toFixed(0)}</b> (peak ${(led.peakEquityUsd ?? led.equityUsd).toFixed(0)})</span>}
        </div>
        {led.stoppedAt && (
          <div className="flex flex-wrap items-center gap-3 text-[12px] p-2 border" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
            AUTO-STOP since {timeAgo(led.stoppedAt)}: {led.stopReason}
            <button className="btn btn-sm ml-auto" disabled={busy} onClick={() => { if (confirm("Clear the auto-stop? Resume trading separately from the kill switch.")) void run(() => post("/api/trading/clear-stop")); }}>Clear</button>
          </div>
        )}
        {led.open.length > 0 && (
          <table className="tbl"><thead><tr><th>Position</th><th>Size</th><th>Opened</th><th></th></tr></thead>
            <tbody>{led.open.map((p) => <tr key={p.id}><td>{p.side} {p.symbol}{p.strategy ? <span style={{ color: "var(--muted)" }}> · {p.strategy}</span> : null}</td><td>${p.sizeUsd}</td><td>{timeAgo(p.openedAt)}</td><td><button className="btn btn-sm" disabled={busy} onClick={() => { const v = prompt(`Realized P&L for ${p.symbol} in USD (negative for a loss)`); if (v !== null && v.trim() !== "" && !Number.isNaN(Number(v))) void run(() => post("/api/trading/close", { positionId: p.id, pnlUsd: Number(v) })); }}>Close</button></td></tr>)}</tbody></table>
        )}
        <form className="flex items-center gap-2 text-[12px]" onSubmit={(e) => { e.preventDefault(); if (equity) void run(() => post("/api/trading/equity", { equityUsd: Number(equity) })).then(() => setEquity("")); }}>
          <span style={{ color: "var(--muted)" }}>Mark equity</span>
          <input className="input h-9 w-32" type="number" min={0} placeholder="$ total" aria-label="Current equity in USD" value={equity} onChange={(e) => setEquity(e.target.value)} />
          <button className="btn btn-sm" disabled={busy || !equity}>Record</button>
          <span style={{ color: "var(--muted)" }}>(a wallet connector will do this automatically)</span>
        </form>
        {t.strategies.length > 0 && <div className="text-[12px]"><span className="label">Enabled strategies</span><div className="flex flex-wrap gap-2 mt-1">{t.strategies.map((s) => <span key={s.name} className="px-2 py-0.5 border rounded-full" style={{ borderColor: "#FF6EC7", color: "#FF6EC7" }}>{s.name}</span>)}</div></div>}
      </div>
    </section>
  );
}
