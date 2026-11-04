"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useLive } from "@/lib/live";
import { post } from "@/lib/api";

const TABS = [
  { href: "/", label: "Home" },
  { href: "/command", label: "Command" },
  { href: "/web", label: "Agent Web" },
  { href: "/approvals", label: "Approvals" },
  { href: "/attention", label: "Needs you" },
  { href: "/activity", label: "Activity" },
  { href: "/usage", label: "Usage" },
];
const MORE = [
  { href: "/ventures", label: "Ventures" },
  { href: "/ambient", label: "Always on" },
  { href: "/brief", label: "Daily brief" },
  { href: "/memory", label: "Memory" },
  { href: "/settings", label: "Settings" },
];

const LEVEL: Record<string, string> = { green: "var(--green)", yellow: "var(--yellow)", orange: "var(--orange)", red: "var(--red)" };

export function Shell({ children, bare }: { children: React.ReactNode; bare?: boolean }) {
  const path = usePathname();
  const { state, connected, pending, attention, refresh } = useLive();
  const openCount = attention.filter((i) => i.status === "open").length;
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const level = state?.status.level ?? "green";
  const killed = state?.status.killSwitch.all;

  const kill = async () => {
    if (!state) return;
    const paused = !killed;
    if (paused && !confirm("Pause the whole web? Every agent stops until you resume.")) return;
    setBusy(true);
    try { await post("/api/kill", { scope: "all", paused }); await refresh(); } finally { setBusy(false); }
  };

  return (
    <div className="grid-bg min-h-dvh flex flex-col relative" style={{ zIndex: 1 }}>
      {!bare && (
        <header className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: "var(--line)", background: "rgba(5,12,32,0.7)", backdropFilter: "blur(6px)" }}>
          <Link href="/" className="flex items-center gap-2 min-w-0">
            <span className="inline-block w-3.5 h-3.5 rounded-full border-2 flex-none" style={{ borderColor: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
            <span className="display glow font-bold text-[15px] tracking-[0.22em] whitespace-nowrap" style={{ color: "var(--ink-strong)" }}>J.A.R.V.I.S. · HQ</span>
            <span role="status" aria-label={`System status ${level}: ${state?.status.text ?? ""}`} title={state?.status.text} className="inline-block w-3 h-3 rounded-full flex-none" style={{ background: LEVEL[level], boxShadow: `0 0 8px ${LEVEL[level]}` }} />
          </Link>
          <span className="hidden md:inline text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{state?.status.text ?? "connecting"} · phase {state?.status.phase ?? "-"}</span>
          <nav className="tabs ml-auto hidden md:flex" style={{ maxWidth: 900, flex: 1 }} aria-label="HQ screens">
            {[...TABS, ...MORE].map((t) => (
              <Link key={t.href} href={t.href} aria-current={path === t.href || (t.href === "/web" && path.startsWith("/agents")) || (t.href === "/ventures" && path.startsWith("/ventures/")) ? "page" : undefined}>
                {t.label.replace("Daily ", "")}
                {t.href === "/approvals" && pending.length > 0 && <span className="badge">{pending.length}</span>}
                {t.href === "/attention" && openCount > 0 && <span className="badge">{openCount}</span>}
              </Link>
            ))}
          </nav>
          <span title={connected ? "live" : "reconnecting"} className="dot flex-none" style={{ background: connected ? "var(--green)" : "var(--st-idle)", boxShadow: connected ? "0 0 8px var(--green)" : "none" }} />
          <button className={`btn btn-sm ${killed ? "btn-primary" : "btn-danger"}`} onClick={kill} disabled={busy || !state} aria-label={killed ? "Resume the whole web" : "Pause all agents"}>
            {killed ? "Resume web" : "Kill switch"}
          </button>
        </header>
      )}
      <main className="flex-1 flex flex-col min-h-0 pb-16 md:pb-0">{children}</main>
      {!bare && (
        <div className="fixed bottom-0 left-0 right-0 md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)", background: "rgba(5,12,32,0.92)", zIndex: 20 }}>
          {more && (
            <div className="tabs flex-wrap border-b" style={{ borderColor: "var(--line)" }} role="menu">
              {[TABS[2]!, ...TABS.slice(5), ...MORE].map((t) => <Link key={t.href} href={t.href} role="menuitem" onClick={() => setMore(false)} aria-current={path === t.href ? "page" : undefined} style={{ flexBasis: "33%" }}>{t.label}</Link>)}
            </div>
          )}
          <nav className="tabs" aria-label="HQ screens">
            {[TABS[0]!, TABS[1]!, TABS[3]!, TABS[4]!].map((t) => (
              <Link key={t.href} href={t.href} aria-current={path === t.href || (t.href === "/web" && path.startsWith("/agents")) ? "page" : undefined}>
                {t.label.replace("Agent ", "")}
                {t.href === "/approvals" && pending.length > 0 && <span className="badge">{pending.length}</span>}
                {t.href === "/attention" && openCount > 0 && <span className="badge">{openCount}</span>}
              </Link>
            ))}
            <button onClick={() => setMore(!more)} aria-expanded={more} aria-label="More screens" style={more ? { borderColor: "var(--accent)" } : undefined}>More</button>
          </nav>
        </div>
      )}
    </div>
  );
}
