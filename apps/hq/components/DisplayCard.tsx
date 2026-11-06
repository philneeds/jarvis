"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/** The picture the home screen shows when the display is off. Joi's skyline until one is set. */
export function DisplayCard() {
  const [bg, setBg] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { api<{ background: string | null }>("/api/display").then((r) => setBg(r.background)).catch(() => undefined); }, []);

  const upload = async (f?: File) => {
    if (!f) return;
    setBusy(true); setMsg(undefined);
    try {
      const r = await api<{ background: string }>("/api/display/background", { method: "POST", body: f, headers: { "content-type": f.type || "image/jpeg" } });
      setBg(r.background); setMsg("Saved. Press Display off on the home screen to see it.");
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section id="display" className="card flex flex-col gap-3 scroll-mt-20" aria-label="Display off picture">
      <div className="flex items-center gap-3">
        <span className="label">Display off picture</span>
        <span className="ml-auto flex gap-2">
          {bg && <button className="btn btn-sm" disabled={busy} onClick={async () => { await api("/api/display/background", { method: "DELETE" }).catch(() => undefined); setBg(null); setMsg("Back to Joi's skyline."); }}>Remove</button>}
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : bg ? "Replace" : "Upload"}</button>
        </span>
        <input ref={input} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {bg ? <img src={`/api/uploads/${bg}`} alt="Display off picture" className="w-full max-h-56 object-cover border" style={{ borderColor: "var(--line)" }} /> : <p className="m-0 text-[12px]" style={{ color: "var(--muted)" }}>Shown full screen when you press Display off. JPEG, PNG or WebP, up to 20 MB.</p>}
      {msg && <p className="m-0 text-[12px]" style={{ color: "var(--amber)" }}>{msg}</p>}
    </section>
  );
}
