import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { getAgentConfig, DiscordConnector, EagleViewConnector, LeadPerfectionConnector, GithubConnector, GoHighLevelConnector, GoogleConnector, RobinhoodConnector, runBackup, Jarvis, KuberaConnector, Scheduler, SpotifyConnector, TradingGuard, Watchers, XConnector, Workshop, SHIP_KEY, defaultRunner, readOnlyQuery, bus, parseTrade, storeFromEnv, usageSummary, type JarvisEvent } from "@jarvis/core";
import { TelegramBot } from "./telegram.js";
import { createApp } from "./app.js";
import { authEnabled, fromHq, isAuthedRequest } from "./auth.js";
import { notify } from "./notify.js";

const port = Number(process.env.PORT ?? 4000);
// The commit this process runs. HQ's screens compare it on every reconnect and reload themselves after a deploy,
// so a tab left open during one of Einstein's ships doesn't break on the next click.
import { execFileSync } from "node:child_process";
const BUILD = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return process.env.JARVIS_BUILD ?? "dev"; } })();
const store = storeFromEnv();
await store.init();
const jarvis = new Jarvis({ store, notify });
// Keys Phil pasted into Settings (sealed in the store) come into memory once; a problem is said, never fatal.
await jarvis.secrets.load().catch((e) => console.warn("[secrets] load:", (e as Error).message));
{ const k = jarvis.secrets.status("GEMINI_API_KEY"); if (k.problem) console.warn(`[secrets] GEMINI_API_KEY: ${k.problem}`); else if (k.source === "settings") console.log(`[secrets] GEMINI_API_KEY from Settings (saved ${k.savedAt})`); }
const google = GoogleConnector.fromEnv(store);
if (google) {
  jarvis.addConnector(google, GoogleConnector.promptHint());
  // Filled-in meeting decks go to Drive as Google Slides, in the venture's deck folder ("ProEdge decks"), in the agent's
  // own Google account when it has one set.
  jarvis.slidesExport = async (title, pptx, agentId, folder) => {
    const account = (await getAgentConfig(store, agentId)).accounts?.[0];
    const id = await google.driveUpload(title, pptx, "application/vnd.openxmlformats-officedocument.presentationml.presentation", account, { folder, convertTo: "application/vnd.google-apps.presentation" });
    return `https://docs.google.com/presentation/d/${id}/edit`;
  };
}
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
// JD PM's EagleView: roof measurement reports (read); ordering one costs money and waits for Phil.
const eagleview = EagleViewConnector.fromEnv(store);
if (eagleview) jarvis.addConnector(eagleview, EagleViewConnector.promptHint());
// ProEdge's LeadPerfection, through a browser (it has no API): read freely; the schedule is entered only after Phil approves.
const leadperfection = LeadPerfectionConnector.fromEnv(store);
if (leadperfection) { jarvis.addConnector(leadperfection, LeadPerfectionConnector.promptHint()); for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void leadperfection.close().finally(() => process.exit(0))); }
// House's biotech Discord (read-only) and the repos Phil shares with Jason, Paul and Ansem (read-only).
const discord = DiscordConnector.fromEnv(store);
if (discord) jarvis.addConnector(discord, DiscordConnector.promptHint());
const github = GithubConnector.fromEnv(store);
if (github) jarvis.addConnector(github, GithubConnector.promptHint());
// Robinhood's official agent access, for Buffett and Munger: Phil connects it from Settings; orders wait for his approval.
const robinhood = RobinhoodConnector.fromEnv(store);
jarvis.addConnector(robinhood, RobinhoodConnector.promptHint());
// Einstein's workshop: a copy of the code he can change and test; ships through Phil's approval, deploys itself.
const workshop = Workshop.fromEnv();
if (workshop) {
  jarvis.useWorkshop(workshop, {
    logs: async (n) => (await defaultRunner("journalctl", ["-u", "jarvis-server", "-n", String(n), "--no-pager", "-o", "cat"], { cwd: process.cwd(), timeoutMs: 20_000 })).out,
    query: process.env.DATABASE_URL ? readOnlyQuery(process.env.DATABASE_URL) : undefined,
  });
}
// Mayne's hard limits are always on: refused before Phil sees an over-limit trade, and again at execution.
const guard = new TradingGuard(store);
jarvis.addConnector(guard, TradingGuard.promptHint());
jarvis.onApprovalRequested(async (a) => {
  if ((a.payload as { action?: string } | undefined)?.action !== "trade.execute") return undefined;
  try { const c = await guard.check(parseTrade(a.payload)); return c.ok ? undefined : `Mayne's hard limits: ${c.reason}`; } catch (e) { return (e as Error).message; }
});
const app = createApp(jarvis, { google, x, guard, spotify, kubera, ghl, eagleview, leadperfection, discord, github, robinhood, workshop });

// Live feed for HQ: agent status, chat, approvals, activity, usage, system status.
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
const sockets = new Set<{ send(data: string): void }>();
app.get(
  "/ws",
  async (c, next) => {
    if (!isAuthedRequest(c.req.raw)) return c.text("unauthorized", 401);
    // The live feed carries chat and approvals; a page on another site must not be able to open it with Phil's cookie.
    if (!fromHq(c.req.header("origin"), (process.env.HQ_ORIGIN ?? "http://localhost:3000").split(",").map((s) => s.trim()), c.req.header("x-forwarded-host") ?? c.req.header("host"))) return c.text("forbidden", 403);
    await next();
  },
  upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      sockets.add(ws);
      void (async () => {
        ws.send(JSON.stringify({ type: "hello", build: BUILD, status: await jarvis.systemStatus(), agents: await jarvis.snapshot(), usage: await usageSummary(store) }));
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

// One background promise that rejects (a late agent report, a store hiccup) must not take HQ down: Node exits on an
// unhandled rejection by default, which restarts the server and loses every run in flight.
process.on("unhandledRejection", (e) => console.error("[unhandled]", e instanceof Error ? e.stack ?? e.message : e));

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
const pruned = await jarvis.pruneRunReports().catch(() => 0);
if (pruned) console.log(`Took ${pruned} run summaries off the venture boards`);
// Agents folded into skills or retired leave a state row behind that still shows on the Agent Web.
const retired = await jarvis.pruneRetiredAgents().catch(() => [] as string[]);
if (retired.length) console.log(`Dropped state rows of retired agents: ${retired.join(", ")}`);
// A ship that was in flight when HQ restarted: say how it went.
// The deploy script writes its verdict only after it has seen HQ answer, which is after this line runs: look now, and
// keep looking for four minutes before giving the last word. (Looking once called every rollback "didn't report
// back", so the bad commit was never taken off the branch and the next update offered it again.)
{
  const settle = async (tries: number): Promise<void> => {
    const last = tries >= 12;
    const said = await jarvis.finishShip({ wait: !last }).catch((e) => { console.warn("[workshop] finish:", (e as Error).message); return "error"; });
    if (said === undefined && !last && (await store.settings.get<{ status?: string } | null>(SHIP_KEY, null))?.status === "shipping") setTimeout(() => void settle(tries + 1), 20_000).unref();
  };
  void settle(0);
}
// Hourly: new code on GitHub that HQ isn't running becomes one "Update HQ" card under Needs you.
if (workshop) jarvis.tasks.set("update-check", () => jarvis.checkForUpdate());
if (stale.length) console.log(`[boot] cleared stale work: ${stale.join(", ")}`);
// The Command center's setup goal, brought up to date once at start (then hourly by the setup-check routine).
void jarvis.syncSetupGoal().catch((e) => console.warn("[setup]", (e as Error).message));
if (process.env.SCHEDULER !== "0") scheduler.start();
// Watchers: cheap looks at GoHighLevel and the markets every few minutes; a lead wakes only when something new happened.
const watchers = new Watchers(jarvis, { ghl, google });
if (process.env.SCHEDULER !== "0") watchers.start();

const shutdown = async () => { scheduler.stop(); watchers.stop(); telegram?.stop(); await store.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
