"use client";

import { useEffect, useState } from "react";
import { api, post, put } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";

interface Account { label: string; address: string }
interface Limits { maxTradeUsd?: number; maxDayUsd?: number; auto?: boolean; maxLeverage?: number; maxOpenUsd?: number; maxDayLossUsd?: number; coins?: string[] }
const money = (n?: number) => (n ? `$${n.toLocaleString("en-US")}` : "");
/** The parameters in words, the way the card and Pentoshi's tool put them. */
function limitsLine(l: Limits = {}): string {
  const caps = `${l.maxTradeUsd ? `${money(l.maxTradeUsd)} a trade` : "no per-trade cap"}, ${l.maxDayUsd ? `${money(l.maxDayUsd)} a day` : "no daily cap"}`;
  if (!l.auto) return `Every order waits for your approval card. Caps: ${caps}.`;
  return `Pentoshi trades on his own: up to ${caps}, ${l.maxLeverage}x leverage at most${l.maxOpenUsd ? `, ${money(l.maxOpenUsd)} open at most` : ""}, stopping when down ${money(l.maxDayLossUsd)} over 24 hours, ${l.coins?.length ? `only ${l.coins.join(", ")}` : "any coin"}. An order outside these is a card for you; changing them is always your call.`;
}

/**
 * A Settings row for wallets an agent reads by public address (Hyperliquid for Pentoshi, Polymarket for Cat). A public
 * address only shows what the account holds; it can't move anything, and HQ never asks for a private key.
 */
export function WalletAccounts({ name, blurb, api: base, hint }: { name: string; blurb: string; api: string; hint?: string }) {
  const [list, setList] = useState<Account[]>();
  const [trading, setTrading] = useState<{ trading: boolean; agent?: string; account?: string; problem?: string; limits?: Limits }>();
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [msg, setMsg] = useState<string>();
  const [bad, setBad] = useState(false);
  useEffect(() => { api<{ accounts: Account[]; trading?: typeof trading }>(`/api/${base}/accounts`).then((r) => { setList(r.accounts); setTrading(r.trading); }).catch((e) => { setBad(true); setMsg((e as Error).message); }); }, []);

  const save = async (next: Account[]) => {
    setMsg(undefined); setBad(false);
    try { const r = await put<{ accounts: Account[] }>(`/api/${base}/accounts`, { accounts: next }); setList(r.accounts); return true; }
    catch (e) { setBad(true); setMsg((e as Error).message); return false; }
  };
  const check = async () => {
    setMsg(`Reading ${name}…`); setBad(false);
    try { setMsg((await post<{ summary: string }>(`/api/connectors/${base}/test`, {})).summary); }
    catch (e) { setBad(true); setMsg((e as Error).message); }
  };
  const looksPrivate = /^(0x)?[0-9a-fA-F]{64}$/.test(address.trim());

  return (
    <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label={name}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`dot ${list?.length ? "dot-working" : "dot-idle"}`} />
        <BrandLogo name={name} /><span className="flex-1 basis-64 min-w-0"><b>{name}</b> · {blurb}</span>
        {list?.length ? <button className="btn btn-sm ml-auto" onClick={() => void check()}>Check now</button> : null}
      </div>
      <div className="flex flex-col gap-1.5 pl-6">
        {list?.map((a, i) => (
          <div key={a.address} className="flex flex-wrap items-center gap-2">
            <b style={{ color: "var(--ink-bright)" }}>{a.label}</b>
            <code style={{ color: "var(--muted)" }}>{a.address.slice(0, 8)}…{a.address.slice(-6)}</code>
            <button className="btn btn-sm ml-auto" aria-label={`Remove ${a.label}`} onClick={() => void save(list.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <form className="flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); if (await save([...(list ?? []), { label: label.trim() || (list?.length ? `Account ${list.length + 1}` : "Main"), address: address.trim() }])) { setLabel(""); setAddress(""); } }}>
          <input className="input h-8 w-28" placeholder="Name (Main)" aria-label="Account name" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
          <input className="input h-8 flex-1 min-w-48" placeholder="Public wallet address, 0x…" aria-label={`${name} address`} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" spellCheck={false} />
          <button className="btn btn-sm h-8" disabled={!/^0x[0-9a-fA-F]{40}$/.test(address.trim())}>Add</button>
        </form>
        {trading && (
          <p className="m-0" style={{ color: trading.trading ? "var(--green)" : "var(--muted)" }}>
            {trading.trading
              ? `Trading on for ${trading.account?.slice(0, 8)}…${trading.account?.slice(-6)} through API wallet ${trading.agent?.slice(0, 8)}… (it can trade, not withdraw). ${limitsLine(trading.limits)}`
              : `Trading off: ${trading.problem}.`}
          </p>
        )}
        {trading?.trading && (
          <form className="flex flex-col gap-2" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const auto = f.get("auto") === "on";
            if (auto && !trading.limits?.auto && !confirm("Let Pentoshi place real trades on your Hyperliquid account without asking, inside these caps?")) return;
            const v = (k: string) => String(f.get(k) ?? "").trim();
            const body = { auto, maxTradeUsd: v("trade"), maxDayUsd: v("day"), maxLeverage: v("lev"), maxOpenUsd: v("open"), maxDayLossUsd: v("loss"), coins: v("coins") };
            try { const r = await put<{ limits: Limits }>(`/api/${base}/limits`, body); setTrading({ ...trading, limits: r.limits }); setBad(false); setMsg("Saved."); }
            catch (err) { setBad(true); setMsg((err as Error).message); }
          }}>
            <label className="flex items-center gap-2" style={{ color: "var(--ink)" }}>
              <input type="checkbox" name="auto" defaultChecked={!!trading.limits?.auto} aria-label="Pentoshi trades on his own" />
              <span><b>Pentoshi trades on his own</b> inside the caps below (needs per trade, per day, leverage and loss stop). Off: every order waits for your card.</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input name="trade" className="input h-8 w-28" inputMode="decimal" placeholder="$ per trade" aria-label="Cap per trade in dollars" defaultValue={trading.limits?.maxTradeUsd ?? ""} />
              <input name="day" className="input h-8 w-28" inputMode="decimal" placeholder="$ per day" aria-label="Cap per day in dollars" defaultValue={trading.limits?.maxDayUsd ?? ""} />
              <input name="lev" className="input h-8 w-24" inputMode="decimal" placeholder="max lev. x" aria-label="Leverage cap" defaultValue={trading.limits?.maxLeverage ?? ""} />
              <input name="open" className="input h-8 w-28" inputMode="decimal" placeholder="$ open (opt.)" aria-label="Cap on open positions in dollars, optional" defaultValue={trading.limits?.maxOpenUsd ?? ""} />
              <input name="loss" className="input h-8 w-28" inputMode="decimal" placeholder="$ loss stop" aria-label="Stop trading alone when down this much over 24 hours" defaultValue={trading.limits?.maxDayLossUsd ?? ""} />
              <input name="coins" className="input h-8 w-40" placeholder="coins (empty = any)" aria-label="Coins he trades alone, comma-separated" defaultValue={trading.limits?.coins?.join(", ") ?? ""} />
              <button className="btn btn-sm h-8">Save</button>
            </div>
            <span style={{ color: "var(--muted)" }}>Size is the position&apos;s full size, not the margin. The loss stop uses Hyperliquid&apos;s own 24-hour PnL; past it, new orders wait for you. Closes and cancels always go through.</span>
          </form>
        )}
        {hint && !list?.length && <p className="m-0" style={{ color: "var(--muted)" }}>{hint}</p>}
        {looksPrivate && <p className="m-0" style={{ color: "var(--red)" }}>That looks like a private key, not an address. Don&apos;t paste it anywhere: clear it, and copy your wallet&apos;s public address (0x and 40 characters) instead.</p>}
        {msg && <p className="m-0 whitespace-pre-wrap" style={{ color: bad ? "var(--red)" : "var(--ink)" }}>{msg}</p>}
      </div>
    </div>
  );
}

export const HyperliquidAccounts = () => <WalletAccounts name="Hyperliquid" api="hyperliquid" blurb="Pentoshi reads your own account (positions, liquidation distance, orders, fills, balances) from its public address. Trading needs the API wallet key on the server; then choose below whether every order waits for you or he trades on his own inside your caps." />;
export const LighterAccounts = () => <WalletAccounts name="Lighter" api="lighter" blurb="Pentoshi reads your Lighter account and sub-accounts: positions, liquidation distance, PnL and funding paid. Read-only, from the public address of the wallet you use on Lighter; nothing can be traded." />;
export const PolymarketAccounts = () => <WalletAccounts name="Polymarket" api="polymarket" blurb="Cat reads your own bets: each position's side, price, value and PnL, and winnings to claim. Read-only, from your wallet's public address; nothing can be bet. Market odds on Polymarket and Kalshi need nothing." hint="Your Polymarket address is on your profile page (the 0x… under your name), or in Settings on polymarket.com." />;
