"use client";

import { useEffect, useState } from "react";
import { api, put } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";

interface Limits { auto?: boolean; maxOrderUsd?: number; maxDayUsd?: number; maxOpenUsd?: number }
interface Status { trading: boolean; problem?: string; balance?: number; portfolio?: number; limits?: Limits }
const money = (n?: number) => `$${(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * Settings › Kalshi: whether trading is set up, what the account holds, and the parameters Cat trades inside. With
 * the switch off every order waits for Phil's card; with it on, an order inside every cap goes out on its own and
 * only a change to the caps waits for him.
 */
export function KalshiTrading() {
  const [st, setSt] = useState<Status>();
  const [msg, setMsg] = useState<string>();
  const [bad, setBad] = useState(false);
  useEffect(() => { api<Status>("/api/kalshi").then(setSt).catch((e) => { setBad(true); setMsg((e as Error).message); }); }, []);
  const l = st?.limits ?? {};

  return (
    <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label="Kalshi">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`dot ${st?.trading ? "dot-working" : "dot-idle"}`} />
        <BrandLogo name="Kalshi" /><span className="flex-1 basis-64 min-w-0"><b>Kalshi</b> · Cat trades prediction markets on your Kalshi account. The key on the server can read the account and place and cancel orders; it can&apos;t move money out.</span>
      </div>
      <div className="flex flex-col gap-1.5 pl-6">
        {st && (
          <p className="m-0" style={{ color: st.trading ? "var(--green)" : "var(--muted)" }}>
            {st.trading
              ? `Trading on: ${money(st.balance)} cash, positions worth ${money(st.portfolio)}. ${l.auto ? `Cat trades on her own: up to ${money(l.maxOrderUsd)} an order, ${money(l.maxDayUsd)} a day, ${money(l.maxOpenUsd)} open in all. Changing these is always your call.` : "Every order waits for your approval card."}`
              : `Trading off: ${st.problem}.`}
          </p>
        )}
        {st?.trading && (
          <form className="flex flex-col gap-2" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const auto = f.get("auto") === "on";
            if (auto && !l.auto && !confirm("Let Cat place real trades on your Kalshi account without asking, inside these caps?")) return;
            const v = (k: string) => String(f.get(k) ?? "").trim();
            try { const r = await put<{ limits: Limits }>("/api/kalshi/limits", { auto, maxOrderUsd: v("order"), maxDayUsd: v("day"), maxOpenUsd: v("open") }); setSt({ ...st, limits: r.limits }); setBad(false); setMsg("Saved."); }
            catch (err) { setBad(true); setMsg((err as Error).message); }
          }}>
            <label className="flex items-center gap-2" style={{ color: "var(--ink)" }}>
              <input type="checkbox" name="auto" defaultChecked={!!l.auto} aria-label="Cat trades on her own" />
              <span><b>Cat trades on her own</b> inside the caps below (all three are needed). Off: every order waits for your card.</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input name="order" className="input h-8 w-28" inputMode="decimal" placeholder="$ per order" aria-label="Cap per order in dollars" defaultValue={l.maxOrderUsd ?? ""} />
              <input name="day" className="input h-8 w-28" inputMode="decimal" placeholder="$ per day" aria-label="Cap per day in dollars" defaultValue={l.maxDayUsd ?? ""} />
              <input name="open" className="input h-8 w-32" inputMode="decimal" placeholder="$ open in all" aria-label="Cap on everything open in dollars" defaultValue={l.maxOpenUsd ?? ""} />
              <button className="btn btn-sm h-8">Save</button>
            </div>
            <span style={{ color: "var(--muted)" }}>A contract costs its price and pays $1 if it wins, so what an order costs is the most it can lose. &quot;Open in all&quot; counts what your positions cost plus resting orders. Closing a position always goes through.</span>
          </form>
        )}
        {msg && <p className="m-0 whitespace-pre-wrap" style={{ color: bad ? "var(--red)" : "var(--ink)" }}>{msg}</p>}
      </div>
    </div>
  );
}
