"use client";

import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, post, fmtTime } from "@/lib/api";

interface Passkey { id: string; label: string; createdAt: string }
interface Connectors { google: { configured: boolean; connected: boolean; email?: string }; telegram: { configured: boolean }; ntfy: { configured: boolean } }

export default function SettingsPage() {
  const { state, refresh } = useLive();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [rpID, setRpID] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<Connectors | null>(null);
  const [googleMsg, setGoogleMsg] = useState<string>();

  const load = () => Promise.all([
    api<{ passkeys: Passkey[]; rpID: string }>("/api/passkeys").then((r) => { setPasskeys(r.passkeys); setRpID(r.rpID); }),
    api<Connectors>("/api/connectors").then(setConn),
  ]).catch(() => undefined);
  useEffect(() => { void load(); const g = new URLSearchParams(location.search).get("google"); if (g) setGoogleMsg(g === "connected" ? "Google connected." : g); }, []);
  const connectGoogle = async () => { try { const r = await api<{ url: string }>("/api/connectors/google/auth"); location.href = r.url; } catch (e) { setGoogleMsg((e as Error).message); } };
  const disconnectGoogle = async () => { if (!confirm("Disconnect Google? Monica and the JD PM team lose calendar and mail until you reconnect.")) return; await post("/api/connectors/google/disconnect"); setGoogleMsg(undefined); await load(); };

  const addPasskey = async () => {
    setBusy(true); setMsg(undefined);
    try {
      const optionsJSON = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/passkeys/register/options");
      const response = await startRegistration({ optionsJSON });
      await post("/api/passkeys/register/verify", { response, label: label || undefined });
      setLabel(""); setMsg("Passkey added. You can log in with it from now on."); await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const removePasskey = async (id: string) => { if (!confirm("Remove this passkey?")) return; await api(`/api/passkeys/${id}`, { method: "DELETE" }); await load(); };
  const setPhase = async (phase: number) => { if (!confirm(`Move the web to Phase ${phase}? Agents in that phase go live.`)) return; await post("/api/phase", { phase }); await refresh(); };

  const phase = state?.status.phase ?? 0;
  return (
    <Shell>
      <div className="max-w-3xl w-full mx-auto p-4 flex flex-col gap-4">
        <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>SETTINGS</h1>

        <section className="card flex flex-col gap-3" aria-label="Security">
          <span className="label">Security · passkeys</span>
          <p className="m-0 text-[12px]">HQ can move money, so add a passkey on each phone and laptop you use. The password stays as the fallback. Domain: <code>{rpID || "…"}</code>.</p>
          {passkeys.length === 0 && <p className="m-0 text-[12px]" style={{ color: "var(--amber)" }}>No passkey yet.</p>}
          {passkeys.map((p) => <div key={p.id} className="flex items-center gap-3 text-[12px]"><span className="dot dot-working" /><span>{p.label}</span><span style={{ color: "var(--dim)" }}>{fmtTime(p.createdAt)}</span><button className="btn btn-sm btn-danger ml-auto" onClick={() => removePasskey(p.id)}>Remove</button></div>)}
          <div className="flex gap-2">
            <input className="input h-9" placeholder="Name this device (iPhone, MacBook…)" aria-label="Device name" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={addPasskey}>Add passkey</button>
          </div>
          {msg && <p className="m-0 text-[12px]" style={{ color: msg.startsWith("Passkey added") ? "var(--green)" : "var(--red)" }}>{msg}</p>}
        </section>

        <section className="card flex flex-col gap-3" aria-label="Build phase">
          <span className="label">Build phase</span>
          <p className="m-0 text-[12px]">Each phase starts only after the previous one is used daily for a week. Current: <b>Phase {phase}</b>.</p>
          <div className="flex flex-wrap gap-2">
            {[["0", "Foundation"], ["1", "Stella, Monica, Mantis"], ["2", "Money and growth"], ["3", "Everything else"]].map(([n, name]) => (
              <button key={n} className={`btn btn-sm ${Number(n) === phase ? "btn-primary" : ""}`} onClick={() => setPhase(Number(n))} disabled={Number(n) === phase}>Phase {n} — {name}</button>
            ))}
          </div>
        </section>

        <section className="card flex flex-col gap-2" aria-label="Providers">
          <span className="label">Providers</span>
          {state && Object.entries(state.providers).map(([id, s]) => <div key={id} className="flex items-center gap-2 text-[12px]"><span className={`dot ${s.ok ? "dot-working" : "dot-idle"}`} /><span>{id}</span><span style={{ color: "var(--muted)" }}>{s.ok ? "ready" : s.reason}</span></div>)}
          <p className="m-0 text-[11px]" style={{ color: "var(--muted)" }}>Sign-ins and keys live in <code>.env</code> on the server; see the README.</p>
        </section>

        <section className="card flex flex-col gap-3" aria-label="Connectors">
          <span className="label">Connectors</span>
          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <span className={`dot ${conn?.google.connected ? "dot-working" : "dot-idle"}`} />
            <span><b>Google</b> · Calendar for Monica, Gmail for Stella&apos;s team{conn?.google.email ? ` · ${conn.google.email}` : ""}</span>
            {conn?.google.connected ? <button className="btn btn-sm btn-danger ml-auto" onClick={disconnectGoogle}>Disconnect</button>
              : conn?.google.configured ? <button className="btn btn-sm btn-primary ml-auto" onClick={connectGoogle}>Connect Google</button>
              : <span className="ml-auto" style={{ color: "var(--muted)" }}>set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET</span>}
          </div>
          {googleMsg && <p className="m-0 text-[12px]" style={{ color: googleMsg === "Google connected." ? "var(--green)" : "var(--red)" }}>{googleMsg}</p>}
          <p className="m-0 text-[11px]" style={{ color: "var(--muted)" }}>Reads become tools you tick per agent (calendar_list_events, gmail_search, gmail_read, gmail_create_draft). Sending mail and creating events run only after you approve.</p>
          <div className="flex items-center gap-3 text-[12px]"><span className={`dot ${conn?.telegram.configured ? "dot-working" : "dot-idle"}`} /><span><b>Telegram</b> · talk to Jarvis and approve from your phone</span><span className="ml-auto" style={{ color: "var(--muted)" }}>{conn?.telegram.configured ? "bot polling" : "set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"}</span></div>
          <div className="flex items-center gap-3 text-[12px]"><span className={`dot ${conn?.ntfy.configured ? "dot-working" : "dot-idle"}`} /><span><b>ntfy</b> · push alerts</span><span className="ml-auto" style={{ color: "var(--muted)" }}>{conn?.ntfy.configured ? "on" : "set NOTIFY_WEBHOOK_URL"}</span></div>
        </section>
      </div>
    </Shell>
  );
}
