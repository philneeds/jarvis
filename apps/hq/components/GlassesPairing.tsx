"use client";

import { useEffect, useState } from "react";
import { api, post, put, fmtTime } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";

interface Status { paired: boolean; pairedAt?: string; seenAt?: string; options?: { approvals: boolean; listen: boolean }; heardDays?: number }

/**
 * Settings › Glasses: pair Phil's smart glasses (the Jarvis app on MentraOS) with HQ. The pairing key is shown once,
 * to type into the Jarvis app on his phone; HQ keeps only its hash. The key can ask Jarvis and read the replies, no more.
 */
export function GlassesPairing() {
  const [st, setSt] = useState<Status>();
  const [key, setKey] = useState<string>();
  const [err, setErr] = useState<string>();
  useEffect(() => { api<Status>("/api/glasses").then(setSt).catch((e) => setErr((e as Error).message)); }, []);

  const pair = async () => {
    if (st?.paired && !confirm("Make a new pairing key? The glasses stop working with HQ until you enter the new one.")) return;
    setErr(undefined);
    try { const r = await post<Status & { key: string }>("/api/glasses/pair", {}); setKey(r.key); setSt(r); } catch (e) { setErr((e as Error).message); }
  };
  const unpair = async () => {
    if (!confirm("Unpair the glasses? They can't talk to Jarvis until you pair again.")) return;
    setErr(undefined);
    try { setSt(await api<Status>("/api/glasses/pair", { method: "DELETE" })); setKey(undefined); } catch (e) { setErr((e as Error).message); }
  };
  const address = typeof window === "undefined" ? "" : window.location.origin;
  const setOpt = async (k: "approvals" | "listen", on: boolean) => {
    if (on && k === "approvals" && !confirm("Let the glasses approve cards by voice?\n\nOnly the card exactly as it was read to you is approved. Cards that move money, trade, ship code or update HQ can be rejected from the glasses but still approved only here or in Telegram.")) return;
    if (on && k === "listen" && !confirm("Turn on all-day memory?\n\nBetween questions, everything the glasses hear (you and anyone near you) is sent to HQ, kept sealed for 14 days, and Jarvis can recall it. Some places require everyone's consent to record a conversation; that's your call where you are.")) return;
    setErr(undefined);
    try { setSt(await put<Status>("/api/glasses/options", { [k]: on })); } catch (e) { setErr((e as Error).message); }
  };
  const forget = async () => {
    if (!confirm("Erase everything the glasses heard? It can't be brought back.")) return;
    try { setSt(await api<Status>("/api/glasses/heard", { method: "DELETE" })); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label="Glasses">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`dot ${st?.paired ? (st.seenAt ? "dot-working" : "dot-idle") : "dot-idle"}`} />
        <BrandLogo name="Glasses" /><span className="flex-1 basis-64 min-w-0"><b>Glasses</b> · talk to Jarvis through your Even G2 (the Jarvis app on MentraOS): hold to speak, and the answer shows in your view. The glasses can ask Jarvis and read the replies; anything more is a switch below, off until you turn it on.</span>
        {st?.paired
          ? <><span style={{ color: "var(--dim)" }}>{st.seenAt ? `last heard from ${fmtTime(st.seenAt)}` : "paired, not heard from yet"}</span><button className="btn btn-sm ml-auto" onClick={() => void pair()}>New key</button><button className="btn btn-sm btn-danger" onClick={() => void unpair()}>Unpair</button></>
          : <button className="btn btn-sm btn-primary ml-auto" onClick={() => void pair()}>Pair glasses</button>}
      </div>
      {key && (
        <div className="flex flex-col gap-1 pl-6">
          <p className="m-0" style={{ color: "var(--ink)" }}>In the Jarvis app on your phone (inside MentraOS), enter these two. The key is shown only now.</p>
          <p className="m-0">HQ address: <code style={{ color: "var(--ink-bright)" }}>{address}</code></p>
          <p className="m-0 break-all">Pairing key: <code style={{ color: "var(--ink-bright)" }}>{key}</code> <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(key)}>Copy</button></p>
        </div>
      )}
      {st?.paired && (
        <div className="flex flex-col gap-1.5 pl-6">
          <label className="flex items-start gap-2" style={{ color: "var(--ink)" }}>
            <input type="checkbox" className="mt-0.5" checked={!!st.options?.approvals} onChange={(e) => void setOpt("approvals", e.target.checked)} aria-label="Approvals by voice" />
            <span><b>Approvals by voice.</b> Say &quot;what needs me&quot; to hear the cards waiting on you, then approve, reject or skip each. Money, trades, shipping code and HQ updates can be rejected from the glasses but are approved only here or in Telegram.</span>
          </label>
          <label className="flex items-start gap-2" style={{ color: "var(--ink)" }}>
            <input type="checkbox" className="mt-0.5" checked={!!st.options?.listen} onChange={(e) => void setOpt("listen", e.target.checked)} aria-label="All-day memory" />
            <span><b>All-day memory.</b> Between questions, what the glasses hear is kept on HQ (sealed, 14 days) so Jarvis can recall what was said. It hears everyone near you.</span>
          </label>
          {!!st.heardDays && <span style={{ color: "var(--muted)" }}>{st.heardDays} day{st.heardDays === 1 ? "" : "s"} kept. <button className="underline bg-transparent border-0 p-0 cursor-pointer" style={{ color: "var(--red)" }} onClick={() => void forget()}>Erase all</button></span>}
        </div>
      )}
      {err && <p className="m-0 pl-6" style={{ color: "var(--red)" }}>{err}</p>}
    </div>
  );
}
