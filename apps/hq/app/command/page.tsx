"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Chat } from "@/components/Chat";

function CommandInner() {
  const params = useSearchParams();
  return <Chat initial={params.get("say") ?? undefined} />;
}

export default function CommandPage() {
  return (
    <Shell fill>
      <div className="flex-1 flex flex-col min-h-0 max-w-4xl w-full mx-auto">
        <Suspense><CommandInner /></Suspense>
      </div>
    </Shell>
  );
}
