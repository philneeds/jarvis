/**
 * The link to Phil's Jarvis HQ: three calls, each carrying the pairing key from HQ's Settings › Glasses. The key can
 * ask Jarvis something and read the replies to it; HQ accepts it for nothing else.
 */
export interface HqConfig { url: string; key: string }
export interface Reply { id: string; who: string; kind?: "ack" | "progress" | "final"; text: string }
/** What Phil has switched on for the glasses in HQ › Settings › Glasses. */
export interface HqOptions { approvals: boolean; listen: boolean }
/** A card waiting on Phil, as HQ hands it to the glasses. `print` pins the exact card that was read out. */
export interface Card { id: string; print: string; who: string; title: string; text: string; approvable: boolean; why?: string }
/** HQ refused, with its status: 403 is a switch that is off in Settings, 409 a card that changed or was decided. */
export class HqError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** HQ's address as typed, tidied: https only (plain http just for a machine on the same network while developing). */
export function hqUrl(typed: string): string {
  const t = typed.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  const m = /^(https?):\/\/([^/\s]+)$/i.exec(withScheme);
  if (!m) throw new Error("that isn't HQ's address; it looks like https://hq.example.com");
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(m[2]!);
  if (m[1]!.toLowerCase() === "http" && !local) throw new Error("HQ's address must start with https://");
  return `${m[1]!.toLowerCase()}://${m[2]!}`;
}

export class Hq {
  constructor(private cfg: HqConfig, private f: Fetch) {}

  private async call<T>(path: string, body?: unknown): Promise<T> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.f(`${this.cfg.url}/api/glasses/device/${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${this.cfg.key}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error("can't reach HQ (no connection, or the address is wrong)"); }
    if (res.status === 401) throw new Error("HQ didn't accept the pairing key; pair again in HQ › Settings › Glasses");
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new HqError(j.error ? `HQ said: ${j.error}` : `HQ answered ${res.status}`, res.status);
    return j;
  }

  /** Is HQ there and the key good; and what Phil has switched on for the glasses. */
  async ping(): Promise<HqOptions> { const j = await this.call<Partial<HqOptions>>("ping"); return { approvals: j.approvals === true, listen: j.listen === true }; }
  /** The cards waiting on Phil (refused with 403 until he turns approvals from the glasses on). */
  async cards(): Promise<Card[]> { return (await this.call<{ cards?: Card[] }>("approvals")).cards ?? []; }
  /** Approve or reject the card exactly as it was read out. */
  async decide(card: Pick<Card, "id" | "print">, decision: "approved" | "rejected"): Promise<{ status: string; title: string }> { return this.call("decide", { id: card.id, print: card.print, decision }); }
  /** What was heard between questions, for Phil's all-day memory. */
  async heard(segments: { at: string; text: string }[]): Promise<{ kept: number }> { return this.call("heard", { segments }); }
  /** Send what Phil said (or typed); returns the id to read replies with. */
  async ask(text: string, spoken: boolean): Promise<string> { return (await this.call<{ id: string }>("ask", { text, spoken })).id; }
  /** Replies after the first `seen`; HQ holds the call up to `wait` seconds for something new. */
  async replies(id: string, seen: number, wait = 20): Promise<{ replies: Reply[]; done: boolean }> {
    return this.call(`replies?to=${encodeURIComponent(id)}&seen=${seen}&wait=${wait}`);
  }
}
