import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "About · Jarvis HQ", description: "Jarvis HQ is a private assistant run by its owner for his own businesses." };

/** Public: the app's homepage for Google's sign-in screen. No data, no login. */
export default function AboutPage() {
  return (
    <main className="max-w-2xl w-full mx-auto p-6 flex flex-col gap-4 text-[14px] leading-relaxed" style={{ color: "var(--ink)" }}>
      <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>JARVIS HQ</h1>
      <p className="m-0">Jarvis HQ is a private assistant that one person runs for himself and his own small businesses. It is not offered to the public and has no other users.</p>
      <p className="m-0">It helps its owner with his calendar and email: reading messages, laying out his day, drafting replies, and sending or changing things only after he approves them. It also keeps a nightly backup of its own data in the owner&apos;s Google Drive.</p>
      <p className="m-0">Signing in is limited to the owner&apos;s own Google accounts.</p>
      <p className="m-0 flex gap-4"><Link href="/privacy" style={{ color: "var(--accent)" }}>Privacy policy</Link><Link href="/login" style={{ color: "var(--accent)" }}>Owner sign-in</Link></p>
    </main>
  );
}
