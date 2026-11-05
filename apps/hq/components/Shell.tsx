"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useLive } from "@/lib/live";
import { post } from "@/lib/api";

/** Six primary screens; the rest live under More on every size. Badges on Approvals and Needs you roll up into More on the phone. */
const PRIMARY = [
  { href: "/", label: "Home" },
  { href: "/command", label: "Command" },
  { href: "/attention", label: "Needs you" },
  { href: "/approvals", label: "Approvals" },
  { href: "/web", label: "Agent Web" },
  { href: "/ventures", label: "Ventures" },
];
const MORE = [
  { href: "/brief", label: "Daily brief" },
  { href: "/activity", label: "Activity" },
  { href: "/usage", label: "Usage" },
  { href: "/memory", label: "Memory" },
  { href: "/ambient", label: "Always on" },
  { href: "/settings", label: "Settings" },
];

const LEVEL: Record<string, string> = { green: "var(--green)", yellow: "var(--yellow)", orange: "var(--orange)", red: "var(--red)" };

function isCurrent(path: string, href: string) {
  if (href === "/") return path === "/";
  if (href === "/web") return path === "/web" || path.startsWith("/agents");
  return path === href || path.startsWith(href + "/");
}

/** fill: exactly the viewport's height, so a page like Command scrolls its own list and keeps its input on screen. */
export function Shell({ children, bare, fill }: { children: React.ReactNode; bare?: boolean; fill?: boolean }) {
  const path = usePathname();
  const { state, connected, pending, attention, refresh } = useLive();
  const openCount = attention.filter((i) => i.status === "open").length;
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);          // desktop dropdown
  const [sheet, setSheet] = useState(false);        // phone bottom sheet
  const moreRef = useRef<HTMLDivElement>(null);
  const level = state?.status.level ?? "green";
  const killed = state?.status.killSwitch.all;
  const inMore = MORE.some((t) => isCurrent(path, t.href));

  useEffect(() => {
    if (!more) return;
    const close = (e: MouseEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMore(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMore(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [more]);
  useEffect(() => { setMore(false); setSheet(false); }, [path]);

  const kill = async () => {
    if (!state) return;
    const paused = !killed;
    if (paused && !confirm("Pause the whole web? Every agent stops until you resume.")) return;
    setBusy(true);
    try { await post("/api/kill", { scope: "all", paused }); await refresh(); } finally { setBusy(false); }
  };

  const badge = (href: string) => (href === "/approvals" && pending.length > 0 ? pending.length : href === "/attention" && openCount > 0 ? openCount : 0);
  const tab = (t: { href: string; label: string }, short = false) => (
    <Link key={t.href} href={t.href} aria-current={isCurrent(path, t.href) ? "page" : undefined}>
      {short ? t.label.replace("Agent ", "").replace("Daily brief", "Brief") : t.label}
      {badge(t.href) > 0 && <span className="badge">{badge(t.href)}</span>}
    </Link>
  );

  return (
    <div className={`grid-bg ${fill ? "h-dvh overflow-hidden" : "min-h-dvh"} flex flex-col relative`} style={{ zIndex: 1 }}>
      {!bare && (
        <header className="flex items-center gap-3 px-4 py-2.5 border-b" style={{ borderColor: "var(--line)", background: "rgba(5,12,32,0.7)", backdropFilter: "blur(6px)" }}>
          <Link href="/" className="flex items-center gap-2 min-w-0">
            <span className="inline-block w-3.5 h-3.5 rounded-full border-2 flex-none" style={{ borderColor: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
            <span className="display glow font-bold text-[15px] tracking-[0.22em] whitespace-nowrap" style={{ color: "var(--ink-strong)" }}>J.A.R.V.I.S.</span>
            <span role="status" aria-label={`System status ${level}: ${state?.status.text ?? ""}`} title={state?.status.text} className="inline-block w-3 h-3 rounded-full flex-none" style={{ background: LEVEL[level], boxShadow: `0 0 8px ${LEVEL[level]}` }} />
          </Link>
          <span className="hidden lg:inline text-[11px] tracking-[0.14em] uppercase whitespace-nowrap" style={{ color: "var(--muted)" }}>{state?.status.text ?? "connecting"} · phase {state?.status.phase ?? "-"}</span>
          <nav className="tabs ml-auto hidden md:flex" style={{ maxWidth: 640, flex: 1 }} aria-label="HQ screens">
            {PRIMARY.map((t) => tab(t))}
            <div ref={moreRef} className="relative flex-1 flex">
              <button className="w-full" onClick={() => setMore(!more)} aria-expanded={more} aria-haspopup="menu" aria-current={inMore ? "page" : undefined} style={inMore || more ? { borderColor: "var(--accent)", color: "var(--ink-bright)", background: "rgba(60,130,255,0.25)" } : undefined}>More ▾</button>
              {more && (
                <div role="menu" className="absolute right-0 top-full mt-1 flex flex-col min-w-44 border" style={{ borderColor: "var(--accent-soft)", background: "rgba(5,12,32,0.97)", zIndex: 30, boxShadow: "0 8px 30px rgba(0,0,0,0.5)" }}>
                  {MORE.map((t) => <Link key={t.href} role="menuitem" href={t.href} className="px-4 h-10 flex items-center text-[11px] tracking-[0.14em] uppercase hover:bg-[rgba(60,130,255,0.2)]" style={{ color: isCurrent(path, t.href) ? "var(--ink-bright)" : "var(--ink)", background: isCurrent(path, t.href) ? "rgba(60,130,255,0.18)" : undefined }}>{t.label}</Link>)}
                </div>
              )}
            </div>
          </nav>
          <span title={connected ? "live" : "reconnecting"} className="dot flex-none" style={{ background: connected ? "var(--green)" : "var(--st-idle)", boxShadow: connected ? "0 0 8px var(--green)" : "none" }} />
          <button className={`btn btn-sm ${killed ? "btn-primary" : "btn-danger"}`} onClick={kill} disabled={busy || !state} aria-label={killed ? "Resume the whole web" : "Pause all agents"}>
            {killed ? "Resume" : "Kill"}
          </button>
        </header>
      )}
      <main className="flex-1 flex flex-col min-h-0 pb-16 md:pb-0">{children}</main>
      {!bare && (
        <div className="fixed bottom-0 left-0 right-0 md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)", background: "rgba(5,12,32,0.92)", zIndex: 20 }}>
          {sheet && (
            <div className="tabs flex-wrap border-b" style={{ borderColor: "var(--line)" }} role="menu">
              {[PRIMARY[4]!, PRIMARY[5]!, ...MORE].map((t) => <Link key={t.href} href={t.href} role="menuitem" aria-current={isCurrent(path, t.href) ? "page" : undefined} style={{ flexBasis: "33%" }}>{t.label.replace("Daily brief", "Brief")}</Link>)}
            </div>
          )}
          <nav className="tabs" aria-label="HQ screens">
            {PRIMARY.slice(0, 4).map((t) => tab(t, true))}
            <button onClick={() => setSheet(!sheet)} aria-expanded={sheet} aria-label="More screens" style={sheet || inMore || isCurrent(path, "/web") || isCurrent(path, "/ventures") ? { borderColor: "var(--accent)" } : undefined}>More</button>
          </nav>
        </div>
      )}
    </div>
  );
}
