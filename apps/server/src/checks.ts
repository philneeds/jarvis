import { accountText, backupStatus, coinalyzeCheck, coinglass, healthStatus, hlAccounts, kalshiLimitsText, lighterAccounts, lighterAccountText, limitsText, polyAccounts, polyPositionsText, telegramCheck, xaiCheck, type Jarvis, type Probe } from "@jarvis/core";
import type { createApp } from "./app.js";

type Connectors = NonNullable<Parameters<typeof createApp>[1]>;
const DAY_MS = 86_400_000;
const ago = (at: string, now: number) => { const h = (now - Date.parse(at)) / 3_600_000; return h < 1 ? "under an hour ago" : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`; };
const money = (n?: number) => `$${(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * Every connection HQ has, with one real read-only call that proves it (Settings › Connections check, and Einstein's
 * connections_check). In the order Phil reads them: what money and work ride on first. Not here, because a check
 * would cost a model run or a spoken clip: the Claude and Grok sign-ins and the voice keys.
 */
export function connectionProbes(jarvis: Jarvis, c: Connectors, env: NodeJS.ProcessEnv = process.env, f: typeof fetch = fetch, now: () => number = Date.now): Probe[] {
  const store = jarvis.store;
  /** A wallet list an agent reads by public address: every address answers, or the first that doesn't is the reason. */
  const wallets = <A extends { label: string }>(id: string, name: string, what: string, list: () => Promise<A[]>, read: (a: A) => Promise<string>): Probe => ({
    id, name, what,
    off: async () => ((await list()).length ? undefined : `No address saved. Add your public address under ${name.replace(/ \(.*/, "")} below (never a private key).`),
    run: async () => (await Promise.all((await list()).map((a) => read(a).then((t) => t.split("\n")[0]!)))).join("\n"),
  });
  return [
    {
      id: "google", name: "Google", what: "calendar, Gmail and the Drive folder for backups and decks",
      off: async () => (!c.google ? "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET aren't set on the server." : (await c.google.status()).accounts.length || (await c.google.status()).problem ? undefined : "No account connected. Press Connect under Google below."),
      run: () => c.google!.check(),
    },
    {
      id: "telegram", name: "Telegram", what: "talking to Jarvis and every alert to your phone",
      off: () => (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? undefined : "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID aren't set on the server."),
      run: () => telegramCheck(env.TELEGRAM_BOT_TOKEN!, env.TELEGRAM_CHAT_ID!, f),
    },
    {
      id: "robinhood", name: "Robinhood", what: "Buffett and Munger read your holdings; orders wait for you",
      off: async () => (!c.robinhood ? "The Robinhood connector isn't loaded on this server." : (await c.robinhood.status()).connected || (await c.robinhood.status()).problem ? undefined : "Not connected. Press Connect under Robinhood below, approve at Robinhood, then paste the address it ends on."),
      run: () => c.robinhood!.check(),
    },
    wallets("hyperliquid", "Hyperliquid (reading)", "Pentoshi reads the account by its public address", () => hlAccounts(store, env), (a) => accountText(a, f)),
    {
      id: "hyperliquid-trading", name: "Hyperliquid (trading key)", what: "the API wallet Pentoshi's orders are signed with; it can't withdraw",
      off: () => (c.hlTrader ? undefined : "No trading key. Add an API wallet's key as HYPERLIQUID_AGENT_KEY on the server."),
      run: async () => {
        const s = await c.hlTrader!.status();
        if (!s.trading) throw new Error(s.problem ?? "Hyperliquid doesn't accept the key");
        return `The key is an approved API wallet for ${s.account}. ${limitsText(s.limits)}`;
      },
    },
    {
      id: "kalshi", name: "Kalshi", what: "Cat trades prediction markets; the key can't move money out",
      off: () => (c.kalshi ? undefined : "No API key. Add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_FILE on the server."),
      run: async () => {
        const s = await c.kalshi!.status(true);
        if (!s.trading) throw new Error(s.problem ?? "Kalshi doesn't accept the key");
        return `Kalshi accepted the key: ${money(s.balance)} cash, positions worth ${money(s.portfolio)}. ${kalshiLimitsText(s.limits)}`;
      },
    },
    {
      id: "liquidations", name: "Liquidation data", what: "Pentoshi's liquidation totals (Coinalyze's free API)",
      off: () => (env.COINALYZE_API_KEY?.trim() || env.COINGLASS_API_KEY?.trim() ? undefined : "No key. Add a free Coinalyze key as COINALYZE_API_KEY on the server."),
      run: async () => {
        if (env.COINALYZE_API_KEY?.trim()) return coinalyzeCheck({ key: env.COINALYZE_API_KEY.trim(), fetch: f });
        const rows = await coinglass<unknown[]>("/api/futures/liquidation/coin-list", { key: env.COINGLASS_API_KEY!.trim(), fetch: f });
        return `CoinGlass accepted the key: liquidations for ${rows.length} coins.`;
      },
    },
    wallets("lighter", "Lighter (reading)", "Pentoshi reads the account by its public address", () => lighterAccounts(store), (a) => lighterAccountText(a, f)),
    wallets("polymarket", "Polymarket (reading)", "Cat reads the positions by public address", () => polyAccounts(store), (a) => polyPositionsText(a, f)),
    {
      id: "kubera", name: "Kubera", what: "Munger's net worth picture (read-only)",
      off: () => (c.kubera ? undefined : "KUBERA_API_KEY and KUBERA_SECRET aren't set on the server."),
      run: async () => (await c.kubera!.summary()).split("\n")[0]!,
    },
    {
      id: "ghl", name: "GoHighLevel", what: "JD PM's CRM",
      off: () => (c.ghl ? undefined : "GHL_API_KEY and GHL_LOCATION_ID aren't set on the server."),
      run: () => c.ghl!.check(),
    },
    {
      id: "leadperfection", name: "LeadPerfection", what: "ProEdge's schedule and reports, through a browser sign-in",
      off: () => (c.leadperfection ? undefined : "LP_USER and LP_PASSWORD aren't set on the server."),
      run: () => c.leadperfection!.check(),
      // It signs in through a real browser, and waits its turn behind a report an agent is pulling.
      timeoutMs: 120_000,
    },
    {
      id: "eagleview", name: "EagleView", what: "roof measurement reports for JD PM",
      off: () => (c.eagleview ? undefined : "EAGLEVIEW_CLIENT_ID and EAGLEVIEW_CLIENT_SECRET aren't set on the server."),
      run: () => c.eagleview!.check(),
    },
    {
      id: "github", name: "GitHub", what: "the repos your builders read",
      off: () => (c.github ? undefined : "GITHUB_READ_TOKEN isn't set on the server."),
      run: () => c.github!.check(),
    },
    {
      id: "discord", name: "Discord", what: "House reads the biotech channels",
      off: () => (c.discord ? undefined : "DISCORD_BOT_TOKEN and DISCORD_CHANNELS aren't set on the server."),
      run: () => c.discord!.check(),
    },
    {
      id: "x", name: "X", what: "posting from your accounts, after your approval",
      off: async () => (!c.x ? "X_CLIENT_ID isn't set on the server (it needs an X developer app)." : (await c.x.status()).accounts.length || (await c.x.status()).problem ? undefined : "No account connected. Press Connect under X below."),
      run: () => c.x!.check(),
    },
    {
      id: "xai", name: "X search (xAI)", what: "searching X; billed per search",
      off: () => (env.XAI_API_KEY?.trim() ? undefined : "Off: XAI_API_KEY isn't set. It is a paid API, so it stays off until you say."),
      run: () => xaiCheck(env.XAI_API_KEY!.trim(), f),
    },
    {
      id: "video", name: "Video (Gemini)", what: "every agent can watch a video link",
      off: () => (jarvis.videoStatus().configured ? undefined : "No Gemini key. Paste one under Video below."),
      run: () => jarvis.videoCheck(),
    },
    {
      id: "spotify", name: "Spotify", what: "playlists and what's playing",
      off: async () => (!c.spotify ? "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET aren't set on the server." : (await c.spotify.status()).connected || (await c.spotify.status()).problem ? undefined : "Not connected. Press Connect under Spotify below."),
      run: () => c.spotify!.check(),
    },
    {
      id: "apple-health", name: "Apple Health", what: "sleep, steps and workouts from your iPhone",
      off: async () => ((await healthStatus(store)).keySet ? undefined : "No key made yet. Set it up under Apple Health below."),
      run: async () => {
        const h = await healthStatus(store);
        if (!h.lastIngest) throw new Error("The key is made, but the iPhone app has never sent anything. Open the app and check the key and address in it.");
        if (now() - Date.parse(h.lastIngest.at) > 3 * DAY_MS) throw new Error(`Nothing from the iPhone since ${ago(h.lastIngest.at, now())}. Open the health export app on the phone; it may have stopped syncing in the background.`);
        return `Last sync ${ago(h.lastIngest.at, now())}; ${h.days} days of data held.`;
      },
    },
    {
      id: "backup", name: "Nightly backup", what: "the database, saved on the server and copied to Drive",
      run: async () => {
        const b = await backupStatus(store);
        if (!b) return { state: "unchecked", summary: "No backup has run yet (it runs at 3:15 am). Settings › Backup has a button to run one now." };
        if (!b.ok) throw new Error(`The last backup (${ago(b.at, now())}) failed: ${b.error ?? "no reason recorded"}`);
        if (now() - Date.parse(b.at) > 2 * DAY_MS) throw new Error(`The last good backup was ${ago(b.at, now())}; the nightly run isn't happening.`);
        return `Last backup ${ago(b.at, now())}, ${Math.round((b.bytes ?? 0) / 1024)} KB; Drive copy: ${b.drive ?? "not set"}.`;
      },
    },
    {
      id: "ntfy", name: "ntfy", what: "a second push channel",
      off: () => (env.NOTIFY_WEBHOOK_URL ? undefined : "Off: NOTIFY_WEBHOOK_URL isn't set. Alerts go by Telegram."),
      run: async () => ({ state: "unchecked", summary: "Set. Checking it would send a push to your phone, so it isn't done here." }),
    },
  ];
}
