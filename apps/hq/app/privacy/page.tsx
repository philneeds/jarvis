import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy · Jarvis HQ", description: "How Jarvis HQ uses Google account data." };

/** Public: the privacy policy Google's sign-in screen links to. It must describe exactly what HQ does with Google data. */
export default function PrivacyPage() {
  const h2 = "display font-semibold text-lg m-0 mt-2";
  return (
    <main className="max-w-2xl w-full mx-auto p-6 flex flex-col gap-3 text-[14px] leading-relaxed" style={{ color: "var(--ink)" }}>
      <h1 className="display font-bold text-2xl tracking-[0.2em] m-0" style={{ color: "var(--ink-strong)" }}>PRIVACY POLICY</h1>
      <p className="m-0" style={{ color: "var(--muted)" }}>Jarvis HQ · last updated 13 November 2026</p>
      <p className="m-0">Jarvis HQ is a private assistant used only by its owner, for his own accounts and businesses. Nobody else signs in, and it is not offered to the public.</p>

      <h2 className={h2} style={{ color: "var(--ink-strong)" }}>What it accesses</h2>
      <ul className="m-0 pl-5 flex flex-col gap-1">
        <li><b>Gmail</b> (read, draft, send, label and archive): to summarise the owner&apos;s mail, draft replies, and send or archive messages after he approves. It never deletes mail permanently.</li>
        <li><b>Google Calendar</b>: to show the owner&apos;s schedule and add or change his own events.</li>
        <li><b>Google Drive</b>, limited to files Jarvis HQ creates itself: a nightly backup of its own database.</li>
        <li><b>The account&apos;s email address</b>: to tell the owner&apos;s connected accounts apart.</li>
      </ul>

      <h2 className={h2} style={{ color: "var(--ink-strong)" }}>How it is used</h2>
      <p className="m-0">Google data is used only to provide these features to the owner. It is stored on the owner&apos;s own server. It is not sold, not used for advertising, and not shared with anyone, except that the text of a request the owner makes may be sent to the AI model provider that processes it (Anthropic), only to produce the answer for the owner. No person other than the owner reads the data.</p>
      <p className="m-0">Jarvis HQ&apos;s use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" style={{ color: "var(--accent)" }}>Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

      <h2 className={h2} style={{ color: "var(--ink-strong)" }}>Removing access</h2>
      <p className="m-0">The owner can disconnect any Google account in Jarvis HQ&apos;s settings, or revoke access at any time at <a href="https://myaccount.google.com/permissions" style={{ color: "var(--accent)" }}>myaccount.google.com/permissions</a>. Disconnecting deletes the stored sign-in tokens.</p>

      <h2 className={h2} style={{ color: "var(--ink-strong)" }}>Contact</h2>
      <p className="m-0">Questions go to the support email shown on this app&apos;s Google sign-in screen.</p>
      <p className="m-0"><Link href="/about" style={{ color: "var(--accent)" }}>About Jarvis HQ</Link></p>
    </main>
  );
}
