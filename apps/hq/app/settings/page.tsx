"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DisplayCard } from "@/components/DisplayCard";
import { startRegistration } from "@simplewebauthn/browser";
import { Shell } from "@/components/Shell";
import { useLive } from "@/lib/live";
import { api, post, fmtTime } from "@/lib/api";

interface Passkey { id: string; label: string; createdAt: string }
interface Connectors { google: { configured: boolean; connected: boolean; email?: string; accounts: { email: string; connectedAt?: string }[] }; x: { configured: boolean; accounts: { handle: string; name?: string; connectedAt: string }[] }; spotify?: { configured: boolean; connected: boolean; name?: string; connectedAt?: string }; kubera?: { configured: boolean; lastFetch?: { ok: boolean; at: string; error?: string } | null; days?: number; netWorth?: number }; ghl?: { configured: boolean; lastFetch?: { ok: boolean; at: string; error?: string } | null }; discord?: { configured: boolean; channels?: string[]; lastFetch?: { ok: boolean; at: string; error?: string } | null }; github?: { configured: boolean; repos?: string[]; lastFetch?: { ok: boolean; at: string; error?: string } | null }; robinhood?: { configured: boolean; connected: boolean; connectedAt?: string; lastFetch?: { ok: boolean; at: string; error?: string } | null }; telegram: { configured: boolean }; ntfy: { configured: boolean } }

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
  const [xMsg, setXMsg] = useState<string>();
  const [spMsg, setSpMsg] = useState<string>();
  const [kbMsg, setKbMsg] = useState<string>();
  const [ghlMsg, setGhlMsg] = useState<string>();
  const testGhl = async () => { setGhlMsg("Checking…"); try { const r = await post<{ summary: string }>("/api/connectors/ghl/test", {}); setGhlMsg(r.summary); await load(); } catch (e) { setGhlMsg((e as Error).message); } };
  const [bk, setBk] = useState<{ last: { at: string; ok: boolean; file?: string; bytes?: number; drive?: string; error?: string; kept?: number } | null; dir: string; drive: boolean; healthcheck: boolean } | null>(null);
  const [bkMsg, setBkMsg] = useState<string>();
  useEffect(() => { api<typeof bk>("/api/backup").then(setBk).catch(() => undefined); }, []);
  const backupNow = async () => { setBkMsg("Backing up…"); try { const r = await post<{ result: string }>("/api/backup", {}); setBkMsg(r.result); setBk(await api<typeof bk>("/api/backup")); } catch (e) { setBkMsg((e as Error).message); } };
  const [rhMsg, setRhMsg] = useState<string>();
  const connectRobinhood = async () => { try { const r = await api<{ url: string }>("/api/connectors/robinhood/auth"); location.href = r.url; } catch (e) { setRhMsg((e as Error).message); } };
  const disconnectRobinhood = async () => { if (!confirm("Disconnect Robinhood? Buffett and Munger lose the holdings until you reconnect.")) return; await post("/api/connectors/robinhood/disconnect", {}); setRhMsg(undefined); await load(); };
  const [dcMsg, setDcMsg] = useState<string>();
  const [ghMsg, setGhMsg] = useState<string>();
  const testSimple = async (path: string, set: (s: string) => void) => { set("Checking…"); try { const r = await post<{ summary: string }>(path, {}); set(r.summary); await load(); } catch (e) { set((e as Error).message); } };
  const testKubera = async () => { setKbMsg("Checking…"); try { const r = await post<{ summary: string }>("/api/connectors/kubera/test", {}); setKbMsg(r.summary); await load(); } catch (e) { setKbMsg((e as Error).message); } };
  const [health, setHealth] = useState<{ keySet: boolean; lastIngest: { at: string; samples: number; workouts: number } | null; days: number; summary: string } | null>(null);
  const [healthKey, setHealthKey] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const loadHealth = () => api<NonNullable<typeof health>>("/api/apple-health").then(setHealth).catch(() => undefined);
  const makeHealthKey = async (rotate = false) => {
    if (rotate && !confirm("Make a new key? The iPhone app stops syncing until you paste the new one into it.")) return;
    const r = await post<{ key: string }>("/api/apple-health/key", { rotate });
    setHealthKey(r.key); await loadHealth();
  };
  const copy = async (label: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(undefined), 1500); } catch { /* the text is on screen to copy by hand */ } };
  useEffect(() => {
    void load(); void loadHealth();
    const q = new URLSearchParams(location.search);
    const g = q.get("google"); if (g) setGoogleMsg(g.startsWith("connected") ? `Google connected${g.includes(":") && g.split(":")[1] ? ` (${decodeURIComponent(g.split(":")[1]!)})` : ""}.` : g);
    const xq = q.get("x"); if (xq) setXMsg(xq.startsWith("connected:") ? `@${xq.slice(10)} connected.` : xq);
    const sq = q.get("spotify"); if (sq) setSpMsg(sq === "connected" ? "Spotify connected." : sq);
  }, []);
  const connectX = async () => { try { const r = await api<{ url: string }>("/api/connectors/x/auth"); location.href = r.url; } catch (e) { setXMsg((e as Error).message); } };
  const connectSpotify = async () => { try { const r = await api<{ url: string }>("/api/connectors/spotify/auth"); location.href = r.url; } catch (e) { setSpMsg((e as Error).message); } };
  const disconnectSpotify = async () => { if (!confirm("Disconnect Spotify?")) return; await post("/api/connectors/spotify/disconnect", {}); setSpMsg(undefined); await load(); };
  const disconnectX = async (handle: string) => { if (!confirm(`Disconnect @${handle}?`)) return; await post("/api/connectors/x/disconnect", { handle }); setXMsg(undefined); await load(); };
  const connectGoogle = async () => { try { const r = await api<{ url: string }>("/api/connectors/google/auth"); location.href = r.url; } catch (e) { setGoogleMsg((e as Error).message); } };
  const disconnectGoogle = async (email: string) => { if (!confirm(`Disconnect ${email}? Agents lose that calendar and mailbox until you reconnect.`)) return; await post("/api/connectors/google/disconnect", { email }); setGoogleMsg(undefined); await load(); };

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
  const [ready, setReady] = useState<{ phase: number; agents: { agentId: string; name: string; model: string; missing: string[] }[] } | null>(null);
  useEffect(() => { if (phase < 3) api<typeof ready>(`/api/phase/readiness?phase=${phase + 1}`).then(setReady).catch(() => undefined); else setReady(null); }, [phase]);
  return (
    <Shell>
      <div className="max-w-3xl w-full mx-auto p-4 flex flex-col gap-4">
        <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>SETTINGS</h1>

        <DisplayCard />
        <section className="card flex flex-col gap-3" aria-label="Security">
          <span className="label">Security · passkeys</span>
          <p className="m-0 text-[12px]">HQ can move money, so add a passkey on each phone and laptop you use. The password stays as the fallback. Domain: <code>{rpID || "…"}</code>.</p>
          {passkeys.length === 0 && <p className="m-0 text-[12px]" style={{ color: "var(--amber)" }}>No passkey yet. Name this device below and press Add passkey.</p>}
          {passkeys.map((p) => <div key={p.id} className="flex items-center gap-3 text-[12px]"><span className="dot dot-working" /><span>{p.label}</span><span style={{ color: "var(--dim)" }}>{fmtTime(p.createdAt)}</span><button className="btn btn-sm btn-danger ml-auto" onClick={() => removePasskey(p.id)}>Remove</button></div>)}
          <div className="flex gap-2">
            <input className="input h-9" placeholder="Name this device (iPhone, MacBook…)" aria-label="Device name" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={addPasskey}>Add passkey</button>
          </div>
          {msg && <p className="m-0 text-[12px]" style={{ color: msg.startsWith("Passkey added") ? "var(--green)" : "var(--red)" }}>{msg}</p>}
        </section>

        <section className="card flex flex-col gap-3" aria-label="Backups">
          <div className="flex flex-wrap items-center gap-3">
            <span className="label">Backups and downtime alert</span>
            <button className="btn btn-sm ml-auto" onClick={() => void backupNow()}>Back up now</button>
          </div>
          <div className="flex flex-col gap-1 text-[12px]">
            <div className="flex items-center gap-2"><span className={`dot ${bk?.last?.ok ? "dot-working" : bk?.last ? "dot-error" : "dot-idle"}`} /><span><b>Nightly backup</b> at 3:15 am to <code>{bk?.dir ?? "/var/backups/jarvis"}</code>, kept 14 days.</span><span style={{ color: "var(--muted)" }}>{bk?.last ? `${bk.last.ok ? "last" : "FAILED"} ${fmtTime(bk.last.at)}${bk.last.bytes ? ` · ${Math.round(bk.last.bytes / 1024)} KB` : ""}${bk.last.kept ? ` · ${bk.last.kept} kept` : ""}` : "none yet"}</span></div>
            <div className="flex items-center gap-2 pl-5"><span><b>Google Drive copy</b> into a "Jarvis backups" folder.</span><span style={{ color: "var(--muted)" }}>{bk?.drive ? (bk.last?.drive === "uploaded" ? "working" : bk.last?.drive && bk.last.drive !== "skipped" ? bk.last.drive : "runs with the next backup; reconnect Google once so HQ may create the folder") : "connect Google above to enable"}</span></div>
            <div className="flex items-center gap-2"><span className={`dot ${bk?.healthcheck ? "dot-working" : "dot-idle"}`} /><span><b>Downtime alert</b> · HQ pings a check every 5 minutes; when pings stop, that service messages you.</span><span style={{ color: "var(--muted)" }}>{bk?.healthcheck ? "on" : "set HEALTHCHECK_URL (a free healthchecks.io check with a Telegram alert)"}</span></div>
            {bk?.last?.error && <p className="m-0 pl-5" style={{ color: "var(--red)" }}>{bk.last.error}</p>}
            {bkMsg && <p className="m-0 pl-5" style={{ color: /FAILED|error/i.test(bkMsg) ? "var(--red)" : "var(--ink)" }}>{bkMsg}</p>}
          </div>
        </section>
        <section className="card flex flex-col gap-3" aria-label="Build phase">
          <span className="label">Build phase</span>
          <p className="m-0 text-[12px]">Each phase starts only after the previous one is used daily for a week. Current: <b>Phase {phase}</b>.</p>
          <div className="flex flex-wrap gap-2">
            {[["0", "Foundation"], ["1", "Stella, Monica, Mantis"], ["2", "Money and growth"], ["3", "Everything else"]].map(([n, name]) => (
              <button key={n} className={`btn btn-sm ${Number(n) === phase ? "btn-primary" : ""}`} onClick={() => setPhase(Number(n))} disabled={Number(n) === phase}>Phase {n} — {name}</button>
            ))}
          </div>
          {ready && ready.agents.length > 0 && (
            <div className="flex flex-col gap-1 text-[12px]">
              <span className="label">Before phase {ready.phase}: who starts thin</span>
              {ready.agents.some((a) => a.missing.length) ? ready.agents.filter((a) => a.missing.length).map((a) => <div key={a.agentId}><Link href={`/agents/${a.agentId}`} style={{ color: "var(--ink-bright)" }}>{a.name}</Link><span style={{ color: "var(--muted)" }}> · needs {a.missing.join(", ")}</span></div>) : <span style={{ color: "var(--green)" }}>Every phase-{ready.phase} agent has what it needs.</span>}
              <span style={{ color: "var(--dim)" }}>{ready.agents.filter((a) => !a.missing.length).length} of {ready.agents.length} ready. The rest still run; they just can't see that data until it's connected.</span>
            </div>
          )}
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
            <span><b>Google</b> · calendars and mailboxes. Connect each account you want agents to see: yours, JD PM&apos;s, ProEdge&apos;s. The first is the default.</span>
            {conn?.google.configured ? <button className="btn btn-sm btn-primary ml-auto" onClick={connectGoogle}>{conn.google.accounts.length ? "Connect another account" : "Connect Google"}</button>
              : <span className="ml-auto" style={{ color: "var(--muted)" }}>set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET</span>}
          </div>
          {conn?.google.accounts.map((a, i) => <div key={a.email} className="flex items-center gap-3 pl-6 text-[12px]"><span>{a.email}{i === 0 ? <span style={{ color: "var(--muted)" }}> · default</span> : null}</span>{a.connectedAt && <span style={{ color: "var(--dim)" }}>{fmtTime(a.connectedAt)}</span>}<button className="btn btn-sm btn-danger ml-auto" onClick={() => disconnectGoogle(a.email)}>Disconnect</button></div>)}
          {googleMsg && <p className="m-0 text-[12px]" style={{ color: googleMsg.startsWith("Google connected") ? "var(--green)" : "var(--red)" }}>{googleMsg}</p>}
          <p className="m-0 text-[11px]" style={{ color: "var(--muted)" }}>Reads become tools you tick per agent (calendar_list_events, gmail_search, gmail_read, gmail_create_draft). Sending mail and changing the calendar run after you approve, or on their own where an agent&apos;s rules allow that kind.</p>
          <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }}>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`dot ${conn?.x.accounts.length ? "dot-working" : "dot-idle"}`} />
              <span><b>X</b> · Block's team (Boo, ncrypt) runs @philneeds, Allmin runs Range.cool's account and Jeff runs Acres'. One connection per account.</span>
              {conn?.x.configured ? <button className="btn btn-sm btn-primary ml-auto" onClick={connectX}>Connect an X account</button> : <span className="ml-auto" style={{ color: "var(--muted)" }}>set X_CLIENT_ID and X_CLIENT_SECRET</span>}
            </div>
            {conn?.x.accounts.map((a) => <div key={a.handle} className="flex items-center gap-3 pl-6"><span>@{a.handle}{a.name ? ` · ${a.name}` : ""}</span><span style={{ color: "var(--dim)" }}>{fmtTime(a.connectedAt)}</span><button className="btn btn-sm btn-danger ml-auto" onClick={() => disconnectX(a.handle)}>Disconnect</button></div>)}
            {xMsg && <p className="m-0 pl-6" style={{ color: xMsg.endsWith("connected.") ? "var(--green)" : "var(--red)" }}>{xMsg}</p>}
          </div>
          <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }}>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`dot ${conn?.spotify?.connected ? "dot-working" : "dot-idle"}`} />
              <span><b>Spotify</b> · Lip learns your taste from what you play and makes your playlists.</span>
              {conn?.spotify?.connected
                ? <><span style={{ color: "var(--dim)" }}>{conn.spotify.name ?? "connected"}{conn.spotify.connectedAt ? ` · ${fmtTime(conn.spotify.connectedAt)}` : ""}</span><button className="btn btn-sm btn-danger ml-auto" onClick={disconnectSpotify}>Disconnect</button></>
                : conn?.spotify?.configured ? <button className="btn btn-sm btn-primary ml-auto" onClick={connectSpotify}>Connect Spotify</button> : <span className="ml-auto" style={{ color: "var(--muted)" }}>set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET</span>}
            </div>
            {spMsg && <p className="m-0 pl-6" style={{ color: spMsg.endsWith("connected.") ? "var(--green)" : "var(--red)" }}>{spMsg}</p>}
          </div>
          <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label="Robinhood">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`dot ${conn?.robinhood?.connected ? (conn.robinhood.lastFetch && !conn.robinhood.lastFetch.ok ? "dot-error" : "dot-working") : "dot-idle"}`} />
              <span><b>Robinhood</b> · Buffett and Munger read your positions, balances and orders through Robinhood's official agent access. Any order waits for your approval and can only run in your Robinhood Agentic account.</span>
              {conn?.robinhood?.connected
                ? <><span style={{ color: "var(--dim)" }}>connected{conn.robinhood.connectedAt ? ` · ${fmtTime(conn.robinhood.connectedAt)}` : ""}</span><button className="btn btn-sm" onClick={() => void testSimple("/api/connectors/robinhood/test", setRhMsg)}>Check now</button><button className="btn btn-sm btn-danger ml-auto" onClick={disconnectRobinhood}>Disconnect</button></>
                : <button className="btn btn-sm btn-primary ml-auto" onClick={connectRobinhood}>Connect Robinhood</button>}
            </div>
            {(rhMsg || (conn?.robinhood?.lastFetch && !conn.robinhood.lastFetch.ok)) && <p className="m-0 pl-6 whitespace-pre-wrap" style={{ color: rhMsg && !/refused|error|expired|isn't connected|failed/i.test(rhMsg) ? "var(--ink)" : "var(--red)" }}>{rhMsg ?? conn?.robinhood?.lastFetch?.error}</p>}
          </div>
          <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label="Kubera">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`dot ${conn?.kubera?.lastFetch?.ok ? "dot-working" : conn?.kubera?.lastFetch ? "dot-error" : "dot-idle"}`} />
              <span><b>Kubera</b> · Munger reads your net worth, accounts and holdings, read-only.</span>
              {conn?.kubera?.configured
                ? <><span style={{ color: "var(--dim)" }}>{conn.kubera.lastFetch ? `${conn.kubera.lastFetch.ok ? "read" : "failed"} ${fmtTime(conn.kubera.lastFetch.at)}` : "not read yet"}</span><button className="btn btn-sm ml-auto" onClick={() => void testKubera()}>Check now</button></>
                : <span className="ml-auto" style={{ color: "var(--muted)" }}>set KUBERA_API_KEY and KUBERA_SECRET</span>}
            </div>
            {(kbMsg || (conn?.kubera?.lastFetch && !conn.kubera.lastFetch.ok)) && <p className="m-0 pl-6 whitespace-pre-wrap" style={{ color: kbMsg && !/refused|error|limit|isn't set|failed/i.test(kbMsg) ? "var(--ink)" : "var(--red)" }}>{kbMsg ?? conn?.kubera?.lastFetch?.error}</p>}
          </div>
          <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label="GoHighLevel">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`dot ${conn?.ghl?.lastFetch?.ok ? "dot-working" : conn?.ghl?.lastFetch ? "dot-error" : "dot-idle"}`} />
              <span><b>GoHighLevel</b> · Stella's team reads JD PM's contacts, conversations, pipeline, invoices and appointments; replies go out only after you approve them (add the conversations/message.write scope for that).</span>
              {conn?.ghl?.configured
                ? <><span style={{ color: "var(--dim)" }}>{conn.ghl.lastFetch ? `${conn.ghl.lastFetch.ok ? "read" : "failed"} ${fmtTime(conn.ghl.lastFetch.at)}` : "not read yet"}</span><button className="btn btn-sm ml-auto" onClick={() => void testGhl()}>Check now</button></>
                : <span className="ml-auto" style={{ color: "var(--muted)" }}>set GHL_API_KEY (a read-only Private Integration token) and GHL_LOCATION_ID</span>}
            </div>
            {(ghlMsg || (conn?.ghl?.lastFetch && !conn.ghl.lastFetch.ok)) && <p className="m-0 pl-6 whitespace-pre-wrap" style={{ color: ghlMsg && !/refused|error|limit|aren't set|failed/i.test(ghlMsg) ? "var(--ink)" : "var(--red)" }}>{ghlMsg ?? conn?.ghl?.lastFetch?.error}</p>}
          </div>
          <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label="Discord">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`dot ${conn?.discord?.lastFetch?.ok ? "dot-working" : conn?.discord?.lastFetch ? "dot-error" : "dot-idle"}`} />
              <span><b>Discord</b> · House reads the biotech server's channels, read-only{conn?.discord?.channels?.length ? ` (${conn.discord.channels.join(", ")})` : ""}.</span>
              {conn?.discord?.configured
                ? <><span style={{ color: "var(--dim)" }}>{conn.discord.lastFetch ? `${conn.discord.lastFetch.ok ? "read" : "failed"} ${fmtTime(conn.discord.lastFetch.at)}` : "not read yet"}</span><button className="btn btn-sm ml-auto" onClick={() => void testSimple("/api/connectors/discord/test", setDcMsg)}>Check now</button></>
                : <span className="ml-auto" style={{ color: "var(--muted)" }}>set DISCORD_BOT_TOKEN and DISCORD_CHANNELS (label=channelId, comma-separated)</span>}
            </div>
            {(dcMsg || (conn?.discord?.lastFetch && !conn.discord.lastFetch.ok)) && <p className="m-0 pl-6 whitespace-pre-wrap" style={{ color: dcMsg && !/refused|error|limit|aren't set|can't read/i.test(dcMsg) ? "var(--ink)" : "var(--red)" }}>{dcMsg ?? conn?.discord?.lastFetch?.error}</p>}
          </div>
          <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label="GitHub">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`dot ${conn?.github?.lastFetch?.ok ? "dot-working" : conn?.github?.lastFetch ? "dot-error" : "dot-idle"}`} />
              <span><b>GitHub</b> · Jason, the dev team, Paul and Ansem read the repos you share, read-only{conn?.github?.repos?.length ? ` (${conn.github.repos.join(", ")})` : ""}.</span>
              {conn?.github?.configured
                ? <><span style={{ color: "var(--dim)" }}>{conn.github.lastFetch ? `${conn.github.lastFetch.ok ? "read" : "failed"} ${fmtTime(conn.github.lastFetch.at)}` : "not read yet"}</span><button className="btn btn-sm ml-auto" onClick={() => void testSimple("/api/connectors/github/test", setGhMsg)}>Check now</button></>
                : <span className="ml-auto" style={{ color: "var(--muted)" }}>set GITHUB_READ_TOKEN (fine-grained, read-only) and optionally GITHUB_REPOS</span>}
            </div>
            {(ghMsg || (conn?.github?.lastFetch && !conn.github.lastFetch.ok)) && <p className="m-0 pl-6 whitespace-pre-wrap" style={{ color: ghMsg && !/refused|error|limit|isn't set|not found/i.test(ghMsg) ? "var(--ink)" : "var(--red)" }}>{ghMsg ?? conn?.github?.lastFetch?.error}</p>}
          </div>
          <div className="flex flex-col gap-2 text-[12px] border-t pt-3" style={{ borderColor: "var(--line)" }} aria-label="Apple Health">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`dot ${health?.lastIngest ? "dot-working" : "dot-idle"}`} />
              <span><b>Apple Health</b> · Doc reads your sleep, training and more, sent from your iPhone by the Health Auto Export app.</span>
              {health?.lastIngest
                ? <span className="ml-auto" style={{ color: "var(--dim)" }}>last sync {fmtTime(health.lastIngest.at)} · {health.days} day(s)</span>
                : <button className="btn btn-sm btn-primary ml-auto" onClick={() => void makeHealthKey(false)}>Set up Apple Health</button>}
            </div>
            {(healthKey || (health?.keySet && !health.lastIngest)) && (
              <div className="pl-6 flex flex-col gap-2">
                {healthKey ? (
                  <>
                    <span style={{ color: "var(--muted)" }}>In Health Auto Export on your iPhone: Automations → New → REST API. Paste these two, set Format to JSON, pick the metrics (start with Sleep Analysis, Step Count, Active Energy, Exercise Time, Resting Heart Rate, Heart Rate Variability, Weight) and Workouts, and sync every hour.</span>
                    {[["URL", `${typeof location !== "undefined" ? location.origin : ""}/api/apple-health/ingest`], ["Header", `Authorization: Bearer ${healthKey}`]].map(([k, v]) => (
                      <div key={k} className="flex flex-wrap items-center gap-2">
                        <span className="w-14 text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{k}</span>
                        <code className="flex-1 min-w-0 break-all px-2 py-1 border" style={{ borderColor: "var(--line)" }}>{v}</code>
                        <button className="btn btn-sm" onClick={() => void copy(k!, k === "Header" ? healthKey : v!)}>{copied === k ? "Copied" : k === "Header" ? "Copy key" : "Copy"}</button>
                      </div>
                    ))}
                    <span style={{ color: "var(--dim)" }}>In the app, the header name is Authorization and the value is Bearer followed by the key. Keep the key private; it only lets data in.</span>
                  </>
                ) : <button className="btn btn-sm self-start" onClick={() => void makeHealthKey(false)}>Show setup again</button>}
              </div>
            )}
            {health?.lastIngest && (
              <div className="pl-6 flex flex-col gap-1">
                <pre className="m-0 whitespace-pre-wrap text-[11px]" style={{ color: "var(--ink)" }}>{health.summary}</pre>
                <div className="flex gap-2"><button className="btn btn-sm" onClick={() => void makeHealthKey(false)}>Show setup</button><button className="btn btn-sm btn-danger" onClick={() => void makeHealthKey(true)}>New key</button></div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 text-[12px]"><span className={`dot ${conn?.telegram.configured ? "dot-working" : "dot-idle"}`} /><span><b>Telegram</b> · talk to Jarvis and approve from your phone</span><span className="ml-auto" style={{ color: "var(--muted)" }}>{conn?.telegram.configured ? "bot polling" : "set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"}</span></div>
          <div className="flex items-center gap-3 text-[12px]"><span className={`dot ${conn?.ntfy.configured ? "dot-working" : "dot-idle"}`} /><span><b>ntfy</b> · push alerts</span><span className="ml-auto" style={{ color: "var(--muted)" }}>{conn?.ntfy.configured ? "on" : "set NOTIFY_WEBHOOK_URL"}</span></div>
        </section>
      </div>
    </Shell>
  );
}
