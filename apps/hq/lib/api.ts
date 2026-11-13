"use client";

/** Pages anyone can open without signing in: the login screen, and the About and Privacy pages Google's sign-in links to. */
export const PUBLIC_PATHS = ["/login", "/about", "/privacy"];
export const isPublicPath = (p: string) => PUBLIC_PATHS.some((x) => p === x || p.startsWith(`${x}/`));

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  if (res.status === 401 && typeof window !== "undefined" && !isPublicPath(location.pathname)) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T,>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });

export function wsUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  const { protocol, hostname, port } = location;
  const proto = protocol === "https:" ? "wss:" : "ws:";
  // Dev: HQ on 3000, server on 4000. Prod: one origin behind the reverse proxy.
  return port === "3000" ? `${proto}//${hostname}:4000/ws` : `${proto}//${location.host}/ws`;
}

export function timeAgo(iso?: string, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
