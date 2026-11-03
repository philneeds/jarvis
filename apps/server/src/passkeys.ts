import { Hono } from "hono";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransport, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Store } from "@jarvis/core";
import { isAuthed, startSession } from "./auth.js";

/**
 * Passkeys for the single user. Register one while logged in with the password (Agent settings → Security),
 * then log in with it from the login page. Credentials live in settings["passkeys"].
 *   HQ_RP_ID     the domain HQ is served on (default: hostname of the first HQ_ORIGIN, or localhost)
 *   HQ_ORIGIN    allowed origins (comma-separated)
 */
interface StoredPasskey { id: string; publicKey: string; counter: number; transports?: string[]; label: string; createdAt: string }

const origins = (process.env.HQ_ORIGIN ?? "http://localhost:3000").split(",").map((s) => s.trim());
const rpID = process.env.HQ_RP_ID || new URL(origins[0]!).hostname;
const rpName = "Jarvis HQ";
const USER_ID = new TextEncoder().encode("phil");
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const challenges = new Map<string, { value: string; at: number }>();
const putChallenge = (kind: string, value: string) => challenges.set(kind, { value, at: Date.now() });
const takeChallenge = (kind: string) => { const c = challenges.get(kind); challenges.delete(kind); return c && Date.now() - c.at < 5 * 60_000 ? c.value : undefined; };

export function passkeyRoutes(store: Store) {
  const r = new Hono();
  const list = () => store.settings.get<StoredPasskey[]>("passkeys", []);

  r.get("/", async (c) => c.json({ passkeys: (await list()).map(({ id, label, createdAt }) => ({ id, label, createdAt })), rpID }));

  r.post("/register/options", async (c) => {
    if (!isAuthed(c)) return c.json({ error: "log in with the password first" }, 401);
    const existing = await list();
    const options = await generateRegistrationOptions({
      rpName, rpID, userName: "phil", userID: USER_ID, userDisplayName: "Phil",
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransport[] | undefined })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    putChallenge("register", options.challenge);
    return c.json(options);
  });

  r.post("/register/verify", async (c) => {
    if (!isAuthed(c)) return c.json({ error: "log in with the password first" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { response?: RegistrationResponseJSON; label?: string };
    const expectedChallenge = takeChallenge("register");
    if (!body.response || !expectedChallenge) return c.json({ error: "no registration in progress" }, 400);
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response: body.response, expectedChallenge, expectedOrigin: origins, expectedRPID: rpID });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    if (!verification.verified || !verification.registrationInfo) return c.json({ error: "not verified" }, 400);
    const { credential } = verification.registrationInfo;
    const existing = await list();
    const pk: StoredPasskey = { id: credential.id, publicKey: b64(credential.publicKey), counter: credential.counter, transports: credential.transports, label: (body.label || "This device").slice(0, 60), createdAt: new Date().toISOString() };
    await store.settings.set("passkeys", [...existing.filter((p) => p.id !== pk.id), pk]);
    return c.json({ ok: true, id: pk.id });
  });

  r.delete("/:id", async (c) => {
    if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
    await store.settings.set("passkeys", (await list()).filter((p) => p.id !== c.req.param("id")));
    return c.json({ ok: true });
  });

  r.post("/login/options", async (c) => {
    const existing = await list();
    if (!existing.length) return c.json({ error: "no passkeys registered" }, 404);
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred", allowCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransport[] | undefined })) });
    putChallenge("login", options.challenge);
    return c.json(options);
  });

  r.post("/login/verify", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { response?: AuthenticationResponseJSON };
    const expectedChallenge = takeChallenge("login");
    if (!body.response || !expectedChallenge) return c.json({ error: "no login in progress" }, 400);
    const existing = await list();
    const pk = existing.find((p) => p.id === body.response!.id);
    if (!pk) return c.json({ error: "unknown passkey" }, 400);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({ response: body.response, expectedChallenge, expectedOrigin: origins, expectedRPID: rpID, credential: { id: pk.id, publicKey: unb64(pk.publicKey), counter: pk.counter, transports: pk.transports as AuthenticatorTransport[] | undefined } });
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    if (!verification.verified) return c.json({ error: "not verified" }, 401);
    pk.counter = verification.authenticationInfo.newCounter;
    await store.settings.set("passkeys", existing);
    startSession(c);
    return c.json({ ok: true });
  });

  return r;
}
