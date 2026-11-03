import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { GoogleConnector, Jarvis, Scheduler, TradingGuard, XConnector, bus, parseTrade, storeFromEnv, usageSummary, type JarvisEvent } from "@jarvis/core";
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
// Mayne's hard limits are always on: refused before Phil sees an over-limit trade, and again at execution.
const guard = new TradingGuard(store);
jarvis.addConnector(guard, TradingGuard.promptHint());
jarvis.onApprovalRequested(async (a) => {
  if ((a.payload as { action?: string } | undefined)?.action !== "trade.execute") return undefined;
  try { const c = await guard.check(parseTrade(a.payload)); return c.ok ? undefined : `Mayne's hard limits: ${c.reason}`; } catch (e) { return (e as Error).message; }
});
const app = createApp(jarvis, { google, x, guard });

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

const scheduler = new Scheduler(jarvis);
if (process.env.SCHEDULER !== "0") scheduler.start();

const shutdown = async () => { scheduler.stop(); telegram?.stop(); await store.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
