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
  const expected = sign(id).split(".")[1]!;
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
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

export function login(c: Context, given: string): boolean {
  if (!authEnabled) return true;
  const a = Buffer.from(given), b = Buffer.from(password!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const id = createHmac("sha256", secret).update(String(Date.now()) + Math.random()).digest("base64url").slice(0, 24);
  setCookie(c, COOKIE, sign(id), { httpOnly: true, sameSite: "Lax", path: "/", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 30 });
  return true;
}

export function logout(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}
