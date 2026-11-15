import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

/**
 * Single-user login. HQ_PASSWORD gates everything; the cookie is an HMAC of a random session id.
 * No HQ_PASSWORD = open dev mode (the server logs a warning). Passkeys/2FA: see README, next step.
 */
const COOKIE = "hq_session";
const secret = process.env.HQ_SESSION_SECRET || process.env.HQ_PASSWORD || "dev-secret";
const password = process.env.HQ_PASSWORD;

function sign(id: string) {
  return `${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
}
function verify(token: string | undefined): boolean {
  if (!token) return false;
  const [id, sig] = token.split(".");
  if (!id || !sig) return false;
  // Compare byte lengths, not string lengths: a signature with a multi-byte character made timingSafeEqual throw.
  const given = Buffer.from(sig), expected = Buffer.from(sign(id).split(".")[1]!);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const authEnabled = !!password;

export function isAuthed(c: Context): boolean {
  if (!authEnabled) return true;
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && process.env.HQ_TOKEN && bearer === process.env.HQ_TOKEN) return true;
  return verify(getCookie(c, COOKIE));
}

export function isAuthedRequest(req: { headers: { get(n: string): string | null } }): boolean {
  if (!authEnabled) return true;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return verify(m?.[1]);
}

export async function requireAuth(c: Context, next: Next) {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  await next();
}

export function startSession(c: Context) {
  const id = createHmac("sha256", secret).update(String(Date.now()) + Math.random()).digest("base64url").slice(0, 24);
  setCookie(c, COOKIE, sign(id), { httpOnly: true, sameSite: "Lax", path: "/", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 30 });
}

export function login(c: Context, given: string): boolean {
  if (!authEnabled) return true;
  const a = Buffer.from(given), b = Buffer.from(password!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  startSession(c);
  return true;
}

export function logout(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}

/**
 * Did this request come from HQ's own pages? A browser names the page's origin on anything that changes state; one
 * from another site (including another *.sslip.io host, which shares HQ's cookie rules) is refused. No Origin header
 * means it isn't a browser page at all (the Apple Health shortcut, curl), and those carry their own key or none.
 */
export function fromHq(origin: string | undefined, allowed: string[], host?: string): boolean {
  if (!origin) return true;
  if (allowed.some((o) => o.replace(/\/+$/, "").toLowerCase() === origin.replace(/\/+$/, "").toLowerCase())) return true;
  // The page's own host is HQ whatever HQ_ORIGIN says (a custom domain set up later): same host, same site.
  try { return !!host && new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

/** The caller's address as Caddy reports it (the last hop it added), for counting wrong passwords. */
export const clientIp = (forwarded: string | undefined) => forwarded?.split(",").pop()?.trim() || "local";

// Wrong passwords: eight from one address locks that address out for 15 minutes; a passkey or a live session still
// works. Counted per address so someone guessing can't lock Phil out from his own.
const FAILS = new Map<string, { n: number; first: number }>();
const WINDOW_MS = 15 * 60_000, MAX_FAILS = 8;
export function loginWait(who: string, now = Date.now()): number {
  const f = FAILS.get(who);
  if (!f) return 0;
  if (now - f.first >= WINDOW_MS) { FAILS.delete(who); return 0; }
  return f.n >= MAX_FAILS ? WINDOW_MS - (now - f.first) : 0;
}
export function loginFailed(who: string, now = Date.now()) {
  const f = FAILS.get(who);
  if (!f || now - f.first >= WINDOW_MS) FAILS.set(who, { n: 1, first: now }); else f.n++;
  if (FAILS.size > 5000) for (const [k, v] of FAILS) if (now - v.first >= WINDOW_MS) FAILS.delete(k);
}
