import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store/types.js";
import { defineTool, type ToolDef } from "../tools/index.js";
import type { Executor, Describer } from "../jarvis/orchestrator.js";

/**
 * Spotify for Lip: learn Phil's taste from what he plays, and make playlists in his account.
 * Built on the Web API as it stands after Spotify's February 2026 changes: POST /me/playlists to create, and
 * /playlists/{id}/items to add (the old /users/{id}/playlists and /tracks routes are gone); search returns at most 10.
 * A Development Mode app works only while its owner has Spotify Premium.
 *   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET   an app at developer.spotify.com
 *   SPOTIFY_REDIRECT_URI                       <HQ origin>/api/connectors/spotify/callback
 */
export interface SpotifyOptions { clientId: string; clientSecret: string; redirectUri: string; fetch?: typeof fetch; now?: () => number }
export interface SpotifyTokens { access_token: string; refresh_token: string; expires_at: number; scope?: string; userId?: string; name?: string; connectedAt: string }

export const SPOTIFY_SCOPES = ["user-top-read", "user-read-recently-played", "playlist-read-private", "playlist-modify-private", "playlist-modify-public"];
const KEY = "spotify.tokens";
const API = "https://api.spotify.com/v1";
const ACCOUNTS = "https://accounts.spotify.com";

type Track = { uri: string; name: string; artists?: { name: string }[]; album?: { name: string } };
const trackLine = (t: Track) => `${t.name} — ${(t.artists ?? []).map((a) => a.name).join(", ")}${t.album?.name ? ` (${t.album.name})` : ""} [${t.uri}]`;

export class SpotifyConnector {
  readonly id = "spotify";
  private f: typeof fetch;
  private now: () => number;
  private pending = new Set<string>();
  constructor(private store: Store, private opts: SpotifyOptions) {
    this.f = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  static fromEnv(store: Store): SpotifyConnector | undefined {
    const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return undefined;
    const origin = (process.env.HQ_ORIGIN ?? "http://localhost:3000").split(",")[0]!.trim();
    return new SpotifyConnector(store, { clientId: SPOTIFY_CLIENT_ID, clientSecret: SPOTIFY_CLIENT_SECRET, redirectUri: process.env.SPOTIFY_REDIRECT_URI || `${origin}/api/connectors/spotify/callback` });
  }

  // ---- OAuth (authorization code; the secret stays on the server) -----------

  authUrl(): { url: string; state: string } {
    const state = randomBytes(16).toString("base64url");
    this.pending.add(state);
    const u = new URL(`${ACCOUNTS}/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.opts.clientId);
    u.searchParams.set("redirect_uri", this.opts.redirectUri);
    u.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
    u.searchParams.set("state", state);
    return { url: u.toString(), state };
  }

  private basic() { return `Basic ${Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64")}`; }

  async exchangeCode(code: string, state: string): Promise<SpotifyTokens> {
    if (!this.pending.delete(state)) throw new Error("unknown OAuth state");
    const res = await this.f(`${ACCOUNTS}/api/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: this.basic() }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.opts.redirectUri }) });
    if (!res.ok) throw new Error(`Spotify sign-in failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
    const me = await this.f(`${API}/me`, { headers: { authorization: `Bearer ${j.access_token}` } });
    if (!me.ok) throw new Error(me.status === 403 ? "Spotify refused: the app's owner needs Spotify Premium, and this account must be added under the app's users in the Spotify dashboard." : `Spotify /me failed: ${me.status}`);
    const u = (await me.json()) as { id: string; display_name?: string };
    const t: SpotifyTokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: this.now() + (j.expires_in - 60) * 1000, scope: j.scope, userId: u.id, name: u.display_name, connectedAt: new Date().toISOString() };
    await this.store.settings.set(KEY, t);
    return t;
  }

  async disconnect() { await this.store.settings.set(KEY, null); }
  async status() { const t = await this.store.settings.get<SpotifyTokens | null>(KEY, null); return { connected: !!t, name: t?.name, connectedAt: t?.connectedAt }; }

  private async token(): Promise<string> {
    const t = await this.store.settings.get<SpotifyTokens | null>(KEY, null);
    if (!t) throw new Error("Spotify isn't connected. Connect it under Settings.");
    if (t.expires_at > this.now()) return t.access_token;
    const res = await this.f(`${ACCOUNTS}/api/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: this.basic() }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }) });
    if (!res.ok) throw new Error(`Spotify session expired (${res.status}); reconnect under Settings.`);
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    // Spotify may rotate the refresh token; keep whichever is newest.
    await this.store.settings.set(KEY, { ...t, access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: this.now() + (j.expires_in - 60) * 1000 });
    return j.access_token;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.f(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    if (res.status === 429) throw new Error(`Spotify rate limit; try again in ${res.headers.get("retry-after") ?? "a few"} seconds`);
    if (!res.ok) throw new Error(`Spotify ${init.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  // ---- Reading ---------------------------------------------------------------

  async top(type: "artists" | "tracks", range: "short_term" | "medium_term" | "long_term" = "medium_term", limit = 20) {
    const j = await this.api<{ items: (Track & { genres?: string[] })[] }>(`/me/top/${type}?time_range=${range}&limit=${limit}`);
    return j.items;
  }
  async recent(limit = 20) { return (await this.api<{ items: { track: Track; played_at: string }[] }>(`/me/player/recently-played?limit=${limit}`)).items; }
  async search(q: string, type: "track" | "artist" = "track", limit = 5) {
    const j = await this.api<{ tracks?: { items: Track[] }; artists?: { items: { name: string; uri: string; genres?: string[] }[] } }>(`/search?type=${type}&limit=${Math.min(10, limit)}&q=${encodeURIComponent(q)}`);
    return type === "track" ? j.tracks?.items ?? [] : j.artists?.items ?? [];
  }
  async playlists(limit = 20) { return (await this.api<{ items: { id: string; name: string; public?: boolean; items?: { total: number }; tracks?: { total: number }; external_urls?: { spotify?: string } }[] }>(`/me/playlists?limit=${limit}`)).items; }

  // ---- Writing (approval actions) --------------------------------------------

  /** Turn "spotify:track:…" URIs and "Artist - Title" queries into URIs; what can't be found is reported back. */
  private async resolve(tracks: string[]): Promise<{ uris: string[]; missed: string[] }> {
    const uris: string[] = [], missed: string[] = [];
    for (const t of tracks.slice(0, 200)) {
      const s = t.trim();
      if (!s) continue;
      if (/^spotify:track:[A-Za-z0-9]{22}$/.test(s)) { uris.push(s); continue; }
      const id = s.match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/)?.[1];
      if (id) { uris.push(`spotify:track:${id}`); continue; }
      const hit = (await this.search(s, "track", 1))[0] as Track | undefined;
      if (hit?.uri) uris.push(hit.uri); else missed.push(s);
    }
    return { uris: [...new Set(uris)], missed };
  }

  private async addItems(playlistId: string, uris: string[]) {
    for (let i = 0; i < uris.length; i += 100) await this.api(`/playlists/${encodeURIComponent(playlistId)}/items`, { method: "POST", body: JSON.stringify({ uris: uris.slice(i, i + 100) }) });
  }

  tools(): ToolDef[] {
    const range = z.enum(["short_term", "medium_term", "long_term"]).optional().describe("short_term ≈ 4 weeks, medium_term ≈ 6 months, long_term ≈ years");
    return [
      defineTool({
        name: "spotify_top", description: "Phil's top artists or tracks on Spotify over a time range. Use it to learn his taste.",
        schema: { type: z.enum(["artists", "tracks"]), range, limit: z.number().int().min(1).max(50).optional() },
        handler: async (a) => { const items = await this.top(a.type, a.range, a.limit ?? 20); return items.length ? items.map((x, i) => `${i + 1}. ${a.type === "tracks" ? trackLine(x) : `${x.name}${(x as { genres?: string[] }).genres?.length ? ` · ${(x as { genres?: string[] }).genres!.slice(0, 3).join(", ")}` : ""}`}`).join("\n") : "Nothing yet."; },
      }),
      defineTool({
        name: "spotify_recent", description: "What Phil played recently on Spotify, newest first.",
        schema: { limit: z.number().int().min(1).max(50).optional() },
        handler: async (a) => { const items = await this.recent(a.limit ?? 20); return items.length ? items.map((x) => `${x.played_at.slice(0, 16)} ${trackLine(x.track)}`).join("\n") : "Nothing played recently."; },
      }),
      defineTool({
        name: "spotify_search", description: "Search Spotify for tracks or artists (at most 10 results). Tracks come back with their spotify:track URIs for playlists.",
        schema: { q: z.string().min(1).max(200), type: z.enum(["track", "artist"]).optional(), limit: z.number().int().min(1).max(10).optional() },
        handler: async (a) => { const items = await this.search(a.q, a.type ?? "track", a.limit ?? 5); return items.length ? items.map((x) => ("artists" in x || "album" in x ? trackLine(x as Track) : `${(x as { name: string }).name} [${(x as { uri: string }).uri}]`)).join("\n") : "No matches."; },
      }),
      defineTool({
        name: "spotify_playlists", description: "Phil's own Spotify playlists with their ids.",
        schema: { limit: z.number().int().min(1).max(50).optional() },
        handler: async (a) => { const items = await this.playlists(a.limit ?? 20); return items.length ? items.map((p) => `${p.name} · ${(p.items ?? p.tracks)?.total ?? "?"} tracks${p.public ? " · public" : ""} [${p.id}]`).join("\n") : "No playlists."; },
      }),
    ];
  }

  executors(): Record<string, Executor> {
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    return {
      "spotify.playlist.create": async (a) => {
        const p = a.payload as { name?: string; description?: string; public?: boolean; tracks?: unknown };
        if (!p.name?.trim()) throw new Error("a playlist needs a name");
        const { uris, missed } = await this.resolve(list(p.tracks));
        const pl = await this.api<{ id: string; external_urls?: { spotify?: string } }>("/me/playlists", { method: "POST", body: JSON.stringify({ name: p.name.trim().slice(0, 100), description: (p.description ?? "Made by Lip").slice(0, 300), public: p.public === true }) });
        if (uris.length) await this.addItems(pl.id, uris);
        return `Playlist "${p.name}" made with ${uris.length} track(s)${pl.external_urls?.spotify ? `: ${pl.external_urls.spotify}` : ""}.${missed.length ? ` Couldn't find: ${missed.slice(0, 10).join("; ")}.` : ""}`;
      },
      "spotify.playlist.add": async (a) => {
        const p = a.payload as { playlistId?: string; tracks?: unknown };
        if (!p.playlistId) throw new Error("playlistId is required (from spotify_playlists)");
        const { uris, missed } = await this.resolve(list(p.tracks));
        if (!uris.length) throw new Error(`none of the tracks were found${missed.length ? `: ${missed.join("; ")}` : ""}`);
        await this.addItems(p.playlistId, uris);
        return `Added ${uris.length} track(s) to the playlist.${missed.length ? ` Couldn't find: ${missed.slice(0, 10).join("; ")}.` : ""}`;
      },
    };
  }

  describe(): Record<string, Describer> {
    const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    return {
      "spotify.playlist.create": (p) => `Makes a ${p.public === true ? "public" : "private"} playlist "${String(p.name ?? "")}" in your Spotify with ${n(p.tracks)} track(s).${p.public === true ? " Anyone can see a public playlist." : " Only you can see it."}`,
      "spotify.playlist.add": (p) => `Adds ${n(p.tracks)} track(s) to one of your Spotify playlists.`,
    };
  }

  static promptHint(): string {
    return `Spotify is connected (Phil's account). Reading: spotify_top (his top artists or tracks), spotify_recent, spotify_search (max 10), spotify_playlists. Making a playlist = an approval block with "kind":"record" and "payload":{"action":"spotify.playlist.create","name":"...","description":"...","tracks":["spotify:track:<id>" or "Artist - Title", ...]} (private unless Phil asks for public, "public":true). Adding = {"action":"spotify.playlist.add","playlistId":"<id>","tracks":[...]}. Keep what you learn about his taste in a remember block with scope phil and key music:<topic>.`;
  }
}
