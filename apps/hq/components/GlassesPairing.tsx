"use client";

import { useEffect, useState } from "react";
import { api, post, fmtTime } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";

interface Status { paired: boolean; pairedAt?: string; seenAt?: string }

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

  return (
    <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label="Glasses">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`dot ${st?.paired ? (st.seenAt ? "dot-working" : "dot-idle") : "dot-idle"}`} />
        <BrandLogo name="Glasses" /><span className="flex-1 basis-64 min-w-0"><b>Glasses</b> · talk to Jarvis through your Even G2 (the Jarvis app on MentraOS): hold to speak, and the answer shows in your view. The glasses can only ask Jarvis and read the replies; approvals stay on your phone.</span>
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
      {err && <p className="m-0 pl-6" style={{ color: "var(--red)" }}>{err}</p>}
    </div>
  );
}
