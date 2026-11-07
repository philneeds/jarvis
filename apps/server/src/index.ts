import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { DiscordConnector, GithubConnector, GoHighLevelConnector, GoogleConnector, RobinhoodConnector, runBackup, Jarvis, KuberaConnector, Scheduler, SpotifyConnector, TradingGuard, XConnector, bus, parseTrade, storeFromEnv, usageSummary, type JarvisEvent } from "@jarvis/core";
import { TelegramBot } from "./telegram.js";
import { createApp } from "./app.js";
import { authEnabled, isAuthedRequest } from "./auth.js";
import { notify } from "./notify.js";

const port = Number(process.env.PORT ?? 4000);
const store = storeFromEnv();
await store.init();
const jarvis = new Jarvis({ store, notify });
const google = GoogleConnector.fromEnv(store);
if (google) jarvis.addConnector(google, GoogleConnector.promptHint());
const x = XConnector.fromEnv(store);
if (x) jarvis.addConnector(x, XConnector.promptHint());
const spotify = SpotifyConnector.fromEnv(store);
if (spotify) jarvis.addConnector(spotify, SpotifyConnector.promptHint());
// Munger's Kubera (read-only). The day's net worth goes on the Money board once a day.
const kubera = KuberaConnector.fromEnv(store);
if (kubera) {
  jarvis.addConnector(kubera, KuberaConnector.promptHint());
  kubera.onDaily = async (nw) => { await jarvis.recordMetric("money", "net_worth", Math.round(nw), "munger"); };
}
// JD PM's GoHighLevel (read-only): contacts, conversations, pipeline, invoices, appointments.
const ghl = GoHighLevelConnector.fromEnv(store);
if (ghl) jarvis.addConnector(ghl, GoHighLevelConnector.promptHint());
// House's biotech Discord (read-only) and the repos Phil shares with Jason, Paul and Ansem (read-only).
const discord = DiscordConnector.fromEnv(store);
if (discord) jarvis.addConnector(discord, DiscordConnector.promptHint());
const github = GithubConnector.fromEnv(store);
if (github) jarvis.addConnector(github, GithubConnector.promptHint());
// Robinhood's official agent access, for Buffett and Munger: Phil connects it from Settings; orders wait for his approval.
const robinhood = RobinhoodConnector.fromEnv(store);
jarvis.addConnector(robinhood, RobinhoodConnector.promptHint());
// Mayne's hard limits are always on: refused before Phil sees an over-limit trade, and again at execution.
const guard = new TradingGuard(store);
jarvis.addConnector(guard, TradingGuard.promptHint());
jarvis.onApprovalRequested(async (a) => {
  if ((a.payload as { action?: string } | undefined)?.action !== "trade.execute") return undefined;
  try { const c = await guard.check(parseTrade(a.payload)); return c.ok ? undefined : `Mayne's hard limits: ${c.reason}`; } catch (e) { return (e as Error).message; }
});
const app = createApp(jarvis, { google, x, guard, spotify, kubera, ghl, discord, github, robinhood });

// Live feed for HQ: agent status, chat, approvals, activity, usage, system status.
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
const sockets = new Set<{ send(data: string): void }>();
app.get(
  "/ws",
  async (c, next) => {
    if (!isAuthedRequest(c.req.raw)) return c.text("unauthorized", 401);
    await next();
  },
  upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      sockets.add(ws);
      void (async () => {
        ws.send(JSON.stringify({ type: "hello", status: await jarvis.systemStatus(), agents: await jarvis.snapshot(), usage: await usageSummary(store) }));
      })();
    },
    onClose(_evt, ws) { sockets.delete(ws); },
    onMessage(evt, ws) {
      if (String(evt.data) === "ping") ws.send("pong");
    },
  })),
);
bus.onEvent((e: JarvisEvent) => {
  const data = JSON.stringify(e);
  for (const ws of sockets) { try { ws.send(data); } catch { sockets.delete(ws); } }
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Jarvis server on http://localhost:${info.port} (store: ${store.kind}${authEnabled ? "" : ", auth OFF: set HQ_PASSWORD"}${process.env.JARVIS_MOCK === "1" ? ", MOCK providers" : ""})`);
});
injectWebSocket(server);

const telegram = TelegramBot.fromEnv(jarvis);
if (telegram) { telegram.start(); console.log("Telegram bot polling"); }

// Nightly backup (03:15): the database to BACKUP_DIR, a copy to Google Drive when Google is connected.
jarvis.tasks.set("backup", async () => {
  const drive = google ? { upload: (name: string, data: Buffer, mime: string) => google.driveUpload(name, data, mime), prune: (days: number) => google.drivePrune(days) } : undefined;
  const r = await runBackup(store, { drive });
  return r.ok ? `backup ${r.file} (${Math.round((r.bytes ?? 0) / 1024)} KB, ${r.kept} kept, Drive ${r.drive})` : `backup FAILED: ${r.error}`;
});
// Downtime alert: a dead-man's switch. With HEALTHCHECK_URL set (healthchecks.io or similar), HQ pings it every five
// minutes; when the pings stop (server down, process dead, network gone) that service messages Phil.
if (process.env.HEALTHCHECK_URL) {
  const ping = () => fetch(process.env.HEALTHCHECK_URL!, { method: "GET", signal: AbortSignal.timeout(8000) }).catch(() => undefined);
  void ping(); setInterval(() => void ping(), 5 * 60_000);
}
const scheduler = new Scheduler(jarvis);
// Runs that died with the previous process must not show as "working" forever.
const stale = await jarvis.clearStaleWork();
if (stale.length) console.log(`[boot] cleared stale work: ${stale.join(", ")}`);
if (process.env.SCHEDULER !== "0") scheduler.start();

const shutdown = async () => { scheduler.stop(); telegram?.stop(); await store.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
