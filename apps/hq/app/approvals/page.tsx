"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Shell } from "@/components/Shell";

/** Approvals moved into Needs you. Old links (Telegram, bookmarks, /approvals?tab=decided) land on its Approve section. */
export default function ApprovalsRedirect() {
  const router = useRouter();
  useEffect(() => {
    const decided = new URLSearchParams(window.location.search).get("tab") === "decided";
    router.replace(decided ? "/attention?tab=decided#approve" : "/attention#approve");
  }, [router]);
  return (
    <Shell>
      <p className="max-w-3xl w-full mx-auto p-4 text-[12px]" style={{ color: "var(--muted)" }}>
        Approvals now live in <Link href="/attention#approve" style={{ color: "var(--ink-bright)" }}>Needs you</Link>. Taking you there…
      </p>
    </Shell>
  );
}
