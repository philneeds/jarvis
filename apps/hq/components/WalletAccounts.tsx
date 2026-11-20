"use client";

import { useEffect, useState } from "react";
import { api, post, put } from "@/lib/api";

interface Account { label: string; address: string }

/**
 * A Settings row for wallets an agent reads by public address (Hyperliquid for Pentoshi, Polymarket for Cat). A public
 * address only shows what the account holds; it can't move anything, and HQ never asks for a private key.
 */
export function WalletAccounts({ name, blurb, api: base, hint }: { name: string; blurb: string; api: string; hint?: string }) {
  const [list, setList] = useState<Account[]>();
  const [trading, setTrading] = useState<{ trading: boolean; agent?: string; account?: string; problem?: string; limits?: { maxTradeUsd?: number; maxDayUsd?: number } }>();
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
        <span><b>{name}</b> · {blurb}</span>
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
              ? `Trading on for ${trading.account?.slice(0, 8)}…${trading.account?.slice(-6)} through API wallet ${trading.agent?.slice(0, 8)}… (it can trade, not withdraw). Every order waits for your approval card. Limits: ${trading.limits?.maxTradeUsd ? `$${trading.limits.maxTradeUsd} a trade` : "none a trade"}, ${trading.limits?.maxDayUsd ? `$${trading.limits.maxDayUsd} a day` : "none a day"}.`
              : `Trading off: ${trading.problem}.`}
          </p>
        )}
        {hint && !list?.length && <p className="m-0" style={{ color: "var(--muted)" }}>{hint}</p>}
        {looksPrivate && <p className="m-0" style={{ color: "var(--red)" }}>That looks like a private key, not an address. Don&apos;t paste it anywhere: clear it, and copy your wallet&apos;s public address (0x and 40 characters) instead.</p>}
        {msg && <p className="m-0 whitespace-pre-wrap" style={{ color: bad ? "var(--red)" : "var(--ink)" }}>{msg}</p>}
      </div>
    </div>
  );
}

export const HyperliquidAccounts = () => <WalletAccounts name="Hyperliquid" api="hyperliquid" blurb="Pentoshi reads your own account: positions, liquidation distance, orders, fills and balances. Read-only, from your wallet's public address; nothing can be traded." />;
export const LighterAccounts = () => <WalletAccounts name="Lighter" api="lighter" blurb="Pentoshi reads your Lighter account and sub-accounts: positions, liquidation distance, PnL and funding paid. Read-only, from the public address of the wallet you use on Lighter; nothing can be traded." />;
export const PolymarketAccounts = () => <WalletAccounts name="Polymarket" api="polymarket" blurb="Cat reads your own bets: each position's side, price, value and PnL, and winnings to claim. Read-only, from your wallet's public address; nothing can be bet. Market odds on Polymarket and Kalshi need nothing." hint="Your Polymarket address is on your profile page (the 0x… under your name), or in Settings on polymarket.com." />;
