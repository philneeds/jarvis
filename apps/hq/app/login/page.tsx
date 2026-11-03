"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { post } from "@/lib/api";
import { useLive } from "@/lib/live";
import { startAuthentication } from "@simplewebauthn/browser";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useLive();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const passkey = async () => {
    setBusy(true); setError(undefined);
    try {
      const optionsJSON = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/passkeys/login/options");
      const response = await startAuthentication({ optionsJSON });
      await post("/api/passkeys/login/verify", { response });
      await refresh();
      router.replace(params.get("next") || "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message === "no passkeys registered" ? "No passkey yet. Log in with the password, then add one under Settings." : (err as Error).message);
    } finally { setBusy(false); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await post("/api/login", { password });
      await refresh();
      router.replace(params.get("next") || "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="panel-strong p-6 w-full max-w-sm flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="inline-block w-3.5 h-3.5 rounded-full border-2" style={{ borderColor: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
        <span className="display glow font-bold text-lg tracking-[0.22em]" style={{ color: "var(--ink-strong)" }}>J.A.R.V.I.S. · HQ</span>
      </div>
      <p className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Single user. Say the word.</p>
      <label className="label" htmlFor="pw">Password</label>
      <input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      {error && <p className="text-[12px]" style={{ color: "var(--red)" }}>{error}</p>}
      <button className="btn btn-primary" disabled={busy || !password}>Enter HQ</button>
      <button type="button" className="btn" disabled={busy} onClick={passkey}>Use a passkey</button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="grid-bg min-h-dvh flex items-center justify-center p-4">
      <Suspense><LoginForm /></Suspense>
    </div>
  );
}
