"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { AgentWeb } from "@/components/AgentWeb";

function WebInner() {
  const params = useSearchParams();
  return <AgentWeb initial={params.get("agent") ?? undefined} />;
}

export default function WebPage() {
  return (
    <Shell>
      <Suspense><WebInner /></Suspense>
    </Shell>
  );
}
