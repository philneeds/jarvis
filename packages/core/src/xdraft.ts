import { xPostIds } from "./xread.js";

/**
 * Draft links: a link that opens X with a post, reply or quote already written, for Phil to send himself. Nothing
 * goes through X's API, so it costs nothing and is the one way to reply to a stranger's post or to quote one (X keeps
 * API quote posts for Enterprise plans). An agent writes a fenced block and HQ builds the link, so the text is always
 * encoded right:
 *
 *   ```xdraft
 *   {"text":"...", "replyTo":"<post link>"}      a reply
 *   {"text":"...", "quote":"<post link>"}        a quote post
 *   {"text":"...", "video":"<post link>"}        a post that plays that post's video, credited to its author
 *   {"text":"..."}                               a plain post
 *   ```
 */
export interface XDraft { text: string; replyTo?: string; quote?: string; video?: string; label?: string }

const POST_URL = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/;

/** A post's link in the form X turns into an embedded video credited to the author: <post>/video/1. */
export function xVideoLink(link: string): string | undefined {
  const m = link.match(POST_URL);
  return m ? `https://x.com/${m[1]}/status/${m[2]}/video/1` : undefined;
}

/** The link that opens X's composer with this draft in it. */
export function xIntent(d: XDraft): string {
  const u = new URL("https://x.com/intent/post");
  const video = d.video ? xVideoLink(d.video) : undefined;
  u.searchParams.set("text", video && !d.text.includes(video) ? `${d.text.trim()}\n\n${video}` : d.text.trim());
  const reply = d.replyTo ? (/^\d{5,25}$/.test(d.replyTo.trim()) ? d.replyTo.trim() : xPostIds(d.replyTo)[0]) : undefined;
  if (reply) u.searchParams.set("in_reply_to", reply);
  const quote = d.quote?.match(POST_URL);
  if (quote && !video) u.searchParams.set("url", `https://x.com/${quote[1]}/status/${quote[2]}`);
  // X's composer reads %20, not "+", as a space.
  return u.toString().replace(/\+/g, "%20");
}

const labelOf = (d: XDraft) => (d.label?.trim().slice(0, 40) || (d.replyTo ? "Draft reply" : d.quote ? "Draft quote post" : "Draft post"));

/** Every ```xdraft block in an agent's answer becomes a link Phil can tap; a block that can't be read is left as it is. */
export function expandDrafts(text: string): { text: string; drafts: number } {
  let drafts = 0;
  const out = text.replace(/```xdraft\s*\n([\s\S]*?)```/g, (whole, body: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(body.trim()); } catch { return whole; }
    const links: string[] = [];
    for (const it of Array.isArray(parsed) ? parsed : [parsed]) {
      const o = it as Partial<XDraft> | null;
      if (!o || typeof o !== "object" || typeof o.text !== "string" || !o.text.trim()) continue;
      const d: XDraft = { text: o.text, replyTo: typeof o.replyTo === "string" ? o.replyTo : undefined, quote: typeof o.quote === "string" ? o.quote : undefined, video: typeof o.video === "string" ? o.video : undefined, label: typeof o.label === "string" ? o.label : undefined };
      links.push(`[${labelOf(d)} ›](${xIntent(d)})`);
      drafts++;
    }
    return links.length ? links.join("\n") : whole;
  });
  return { text: out, drafts };
}

/** What an agent is told about draft links. */
export const XDRAFT_HINT = 'Draft links: to hand Phil a post, reply or quote he sends himself, write a fenced ```xdraft block holding JSON: {"text":"<the exact text>","replyTo":"<link of the post being replied to>"} for a reply, {"text":"...","quote":"<post link>"} for a quote post, {"text":"...","video":"<link of a post with a video>"} to play that post\'s video inside his post (credited to its author), or {"text":"..."} for a plain post. HQ turns each block into a link that opens X with the text filled in; never write an x.com/intent link yourself. Put the block right after the draft it belongs to, and also show the draft\'s text in plain words above it.';
