import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store/types.js";
import type { ChatMessage } from "./events.js";

/**
 * Phil's smart glasses (Even G2 through MentraOS; apps/glasses is the miniapp). The glasses app runs on his phone,
 * hears him through the glasses, and talks to HQ with one pairing key made in Settings. HQ keeps only the key's hash,
 * so a database dump or backup can't be used to talk to Jarvis as Phil; pairing again replaces the key, unpairing ends it.
 * What the glasses can do with the key: ask Jarvis something and read the replies. Nothing else in HQ accepts it.
 */
const KEY = "glasses.pairing";
interface Pairing { hash: string; at: string; seenAt?: string }

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

/** Make (or replace) the pairing key. Shown to Phil once; only its hash is kept. */
export async function pairGlasses(store: Pick<Store, "settings">): Promise<string> {
  const key = randomBytes(24).toString("base64url");
  await store.settings.set(KEY, { hash: hashOf(key), at: new Date().toISOString() } satisfies Pairing);
  return key;
}
export async function unpairGlasses(store: Pick<Store, "settings">): Promise<void> { await store.settings.set(KEY, null); }

/** Is this the paired glasses' key? Notes when they were last heard from. */
export async function glassesKeyOk(store: Pick<Store, "settings">, given: string | undefined): Promise<boolean> {
  const p = await store.settings.get<Pairing | null>(KEY, null);
  if (!p || !given) return false;
  const a = Buffer.from(p.hash), b = Buffer.from(hashOf(given));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  // Once a minute is enough for "last seen".
  if (!p.seenAt || Date.now() - Date.parse(p.seenAt) > 60_000) await store.settings.set(KEY, { ...p, seenAt: new Date().toISOString() });
  return true;
}
export async function glassesStatus(store: Pick<Store, "settings">): Promise<{ paired: boolean; pairedAt?: string; seenAt?: string }> {
  const p = await store.settings.get<Pairing | null>(KEY, null);
  return p ? { paired: true, pairedAt: p.at, seenAt: p.seenAt } : { paired: false };
}

/**
 * A reply as the glasses can show it: a small text-only display, so no markdown, tables, links or code fences, and
 * lists as plain lines.
 */
export function glassesText(text: string): string {
  return text
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    // A table: its ruler line goes, and each row becomes one line (spaces and tabs only: \s would swallow the line break).
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(\n|$)/gm, "")
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) => row.split("|").map((c) => c.trim()).filter(Boolean).join(" · "))
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]*[-*•][ \t]+/gm, "- ")
    .replace(/\[(Handed to|Deck ready)[^\]]*\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One reply for the glasses: who said it and the text to show. */
export interface GlassesReply { id: string; who: string; kind?: ChatMessage["kind"]; text: string }
export function glassesReplies(messages: ChatMessage[], to: string, name: (agentId?: string) => string): GlassesReply[] {
  return messages.filter((m) => m.replyTo === to && m.role !== "phil").map((m) => ({ id: m.id, who: m.role === "jarvis" ? "Jarvis" : m.role === "system" ? "HQ" : name(m.agentId), kind: m.kind, text: glassesText(m.text) })).filter((m) => m.text);
}

/** Added to what Jarvis reads when Phil asks through the glasses: the answer has to fit a few lines in his view. */
export const GLASSES_HINT = "\n\n(Phil asked this through his smart glasses, by voice, and reads the answer on a small display in his view while doing something else. Answer in one to three short sentences, plain words, the single most useful thing first; no lists, tables, links or formatting. If there is more, say so in a few words and let him ask. An odd word may be a mishearing.)";
