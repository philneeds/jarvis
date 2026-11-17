import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { Store } from "./store/types.js";

/**
 * Keys Phil pastes into Settings instead of /opt/jarvis/.env (today: GEMINI_API_KEY for the video reader).
 *
 * Each one sits in the settings table sealed with AES-256-GCM under a key derived from HQ_SECRETS_KEY, else
 * HQ_SESSION_SECRET, else HQ_PASSWORD, so a database dump, the nightly backup, the JSON store on disk and db_query all
 * show ciphertext. The open values live only in this process's memory, read once at boot (load) and refreshed on every
 * save, so the readers (the video model) can ask synchronously. Write-only: nothing here hands the value to a screen,
 * a log or an agent; status() says whether one is set, where it came from and when, never what it is.
 *
 * An entry in .env still wins over a saved one: the server's own secret is the truth when both exist.
 */
export const SECRET_NAMES = ["GEMINI_API_KEY"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const SECRETS_KEY_PREFIX = "secrets.";
export const settingKeyFor = (name: SecretName) => `${SECRETS_KEY_PREFIX}${name}`;

interface Sealed { v: 1; alg: "aes-256-gcm"; iv: string; tag: string; data: string; at: string }
/** "env" is the reader's own .env entry (it wins); "settings" is one Phil saved here. */
export type SecretSource = "env" | "settings" | "none";
/** What Settings may know: set or not, from where, since when, and what's wrong when a saved one can't be opened. */
export interface SecretStatus { set: boolean; source: SecretSource; savedAt?: string; problem?: string }
/** What a reader (the video model) gets: the current value, where it came from, and whether Settings can keep one. */
export interface SecretReader { get(name: SecretName): string | undefined; status(name: SecretName): SecretStatus; canSave(): boolean }

export const NO_SEALING_KEY = "HQ can't keep keys in Settings until the server has a secret to seal them with: set HQ_PASSWORD (or HQ_SECRETS_KEY) in /opt/jarvis/.env and restart HQ.";
export const UNSEAL_FAILED = "A saved key is there but can't be opened: the server secret it was sealed with (HQ_SECRETS_KEY, HQ_SESSION_SECRET or HQ_PASSWORD) has changed since. Paste the key again.";

const SALT = "hq-secrets-v1";
const isSealed = (x: unknown): x is Sealed => !!x && typeof x === "object" && (x as Sealed).v === 1 && (x as Sealed).alg === "aes-256-gcm" && typeof (x as Sealed).iv === "string" && typeof (x as Sealed).tag === "string" && typeof (x as Sealed).data === "string";

export class Secrets implements SecretReader {
  private open = new Map<SecretName, { value: string; at: string }>();
  private problems = new Map<SecretName, string>();
  constructor(private store: Pick<Store, "settings">, private env: NodeJS.ProcessEnv = process.env, private now: () => Date = () => new Date()) {}

  /** The sealing key, derived once per call from the server secret; undefined in an open dev HQ with no password. */
  private material(): Buffer | undefined {
    const s = (this.env.HQ_SECRETS_KEY || this.env.HQ_SESSION_SECRET || this.env.HQ_PASSWORD || "").trim();
    return s ? scryptSync(s, SALT, 32) : undefined;
  }
  private seal(value: string): Sealed {
    const key = this.material();
    if (!key) throw new Error(NO_SEALING_KEY);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64"), at: this.now().toISOString() };
  }
  private unseal(s: Sealed): string {
    const key = this.material();
    if (!key) throw new Error(NO_SEALING_KEY);
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
  }

  /** Read every saved key into memory. Called once at boot; a key that won't open is remembered as a problem, not a crash. */
  async load(): Promise<void> {
    for (const name of SECRET_NAMES) {
      const raw = await this.store.settings.get<unknown>(settingKeyFor(name), null);
      this.open.delete(name); this.problems.delete(name);
      if (!isSealed(raw)) continue;
      try { this.open.set(name, { value: this.unseal(raw), at: raw.at }); }
      catch (e) { this.problems.set(name, (e as Error).message === NO_SEALING_KEY ? NO_SEALING_KEY : UNSEAL_FAILED); }
    }
  }

  /** What Phil saved, open, or nothing. The reader puts its own .env entry first; this never looks at the environment. */
  get(name: SecretName): string | undefined { return this.open.get(name)?.value; }
  status(name: SecretName): SecretStatus {
    const saved = this.open.get(name);
    const problem = this.problems.get(name);
    return { set: !!saved, source: saved ? "settings" : "none", ...(saved ? { savedAt: saved.at } : {}), ...(problem ? { problem } : {}) };
  }
  /** Whether a key can be saved here at all (the server has something to seal it with). */
  canSave(): boolean { return this.material() !== undefined; }

  /** Save a key Phil pasted. Refused when .env already has one (that one would win and the saved one would be dead weight). */
  async set(name: SecretName, value: string): Promise<void> {
    if (!SECRET_NAMES.includes(name)) throw new Error(`HQ doesn't keep a secret called ${String(name)}`);
    if ((this.env[name] ?? "").trim()) throw new Error(`${name} is set in /opt/jarvis/.env on the server, and that one wins. Remove it there (and restart HQ) to manage it from Settings.`);
    const v = value.trim();
    if (!v) throw new Error("the key is empty");
    if (/\s/.test(v)) throw new Error("that doesn't look like a key: it has spaces or line breaks in it");
    if (v.length > 400) throw new Error("that's too long to be a key");
    const sealed = this.seal(v);
    await this.store.settings.set(settingKeyFor(name), sealed);
    this.open.set(name, { value: v, at: sealed.at });
    this.problems.delete(name);
  }
  /** Forget a saved key. The .env one, if any, is untouched. */
  async clear(name: SecretName): Promise<void> {
    await this.store.settings.set(settingKeyFor(name), null);
    this.open.delete(name); this.problems.delete(name);
  }
}

/**
 * Seal any small JSON value (a connector's sign-in tokens) with the same key the saved keys use, so the settings
 * table, the nightly backup and db_query hold ciphertext. With no server secret (an open dev HQ) it stays as it is.
 */
export function sealJson(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const s = (env.HQ_SECRETS_KEY || env.HQ_SESSION_SECRET || env.HQ_PASSWORD || "").trim();
  if (!s || value === null || value === undefined) return value;
  const key = scryptSync(s, SALT, 32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64"), at: new Date().toISOString() } satisfies Sealed;
}
/** Open what sealJson stored; a value saved before sealing (plain JSON) passes through. Undefined if it can't be opened. */
export function openJson<T>(raw: unknown, env: NodeJS.ProcessEnv = process.env): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!isSealed(raw)) return raw as T;
  const s = (env.HQ_SECRETS_KEY || env.HQ_SESSION_SECRET || env.HQ_PASSWORD || "").trim();
  if (!s) return undefined;
  try {
    const d = createDecipheriv("aes-256-gcm", scryptSync(s, SALT, 32), Buffer.from(raw.iv, "base64"));
    d.setAuthTag(Buffer.from(raw.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(raw.data, "base64")), d.final()]).toString("utf8")) as T;
  } catch { return undefined; }
}
/** Whether a stored value is sealed. */
export const isSealedValue = (x: unknown) => isSealed(x);
