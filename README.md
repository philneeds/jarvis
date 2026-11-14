# Jarvis

One front door to Phil's web of 52 specialist agents across nine ventures. Phil talks to Jarvis in **HQ**, a private phone-first web app; Jarvis routes work to agents, each on the model that fits it, and anything that moves money, posts publicly or messages a customer waits for Phil's OK.

This is **Phase 0 — Foundation** of the [scope outline](https://claude.ai/artifact/DVX4ekT1tjMJuaN3je54vp): the web terminal, Jarvis, the model router (Claude + Grok, others pluggable), shared memory, the action log, the approval queue, and the five MVP screens (Command, Agent Web, Approvals, Activity log, Usage). Gate: Phil can ask Jarvis something and get an answer from a Claude agent and a Grok agent.

## Layout

```
packages/core   the runtime: agent registry (52 agents, 9 ventures), model catalog, model router,
                providers (Claude Agent SDK / API, Grok CLI / API, mock), Jarvis orchestrator,
                approvals + memory blocks, usage rationing, scheduler, Postgres schema + stores
apps/server     Hono API + websocket feed; single-user login; runs Jarvis and the scheduler
apps/hq         Next.js HQ: Home display, Command, Agent Web, Needs you, Activity, Usage (installable PWA)
```

## Run it

Requirements: Node 22, pnpm 10, Postgres (or nothing: the JSON file store works for dev).

```bash
pnpm install
cp .env.example .env            # set HQ_PASSWORD at least
pnpm --filter @jarvis/core build
pnpm db:migrate                 # needs DATABASE_URL; skip for the file store
pnpm dev                        # server on :4000, HQ on :3000
```

Open http://localhost:3000, log in, say `/help`.

No models wired yet? `JARVIS_MOCK=1 pnpm dev` runs the whole thing offline on mock providers (they answer in character and even queue an approval when you ask an agent to send something).

### Models and plans

Every agent names its model in `packages/core/src/registry/agents.ts`; swapping it is a one-line change there, or a dropdown in the Agent Web panel.

| Model key | Runs through | Set up |
| --- | --- | --- |
| `claude-opus`, `claude-sonnet` | Claude Agent SDK on Phil's Claude plan (`CLAUDE_MODE=agent-sdk`, default) | `claude login` once on the server |
| same, fallback | Messages API (`CLAUDE_MODE=api`) | `ANTHROPIC_API_KEY` |
| `grok` | Grok Build CLI, `grok -p` on SuperGrok (`GROK_MODE=cli`, default) | `grok login` once on the server |
| same, or primary | xAI API (`GROK_MODE=api`) | `XAI_API_KEY` |
| X, for every model | xAI X search (`x_search`); the Grok CLI has no X search and X blocks servers' page reads | `XAI_API_KEY` |
| `cursor`, `higgsfield`, `chatgpt-health` | not callable from HQ yet | Jarvis reports it and asks Phil to relay |

The router tries the configured mode first and falls back to the other if it is available. Model ids: `CLAUDE_OPUS_MODEL`, `CLAUDE_SONNET_MODEL`, `GROK_MODEL`.

### Einstein's workshop (HQ changes its own code)

Einstein is HQ's engineer. Ask Jarvis for a change or a fix in plain words and Jarvis delegates it to Einstein, who works in a separate copy of the code (`WORKSHOP_DIR`, `/opt/jarvis-workshop` on the server) on a fresh branch off the live one, with the Claude Agent SDK's file and shell tools inside that directory only. A guard refuses anything outside it, any `.env` or key file, the live app, network or system commands, and `git push`. He can read the server log (`hq_logs`, secrets masked) and run read-only SQL (`db_query`). `workshop_verify` builds, typechecks and tests every package; `workshop_submit` commits and returns the approval block. Phil sees a "Ship:" card under Needs you with the files, the reason and the check results; approving it pushes the commit to the live branch (needs `GITHUB_PUSH_TOKEN`, fine-grained, Contents read and write on the repo) and runs `/usr/local/bin/jarvis-deploy` (installed by `setup.sh`, the one command the app user may run as root), which redeploys, waits for `/api/health`, and rolls back to the previous commit if HQ doesn't answer. On the next boot HQ reports the outcome in chat and on Telegram, and reverts a rolled-back commit on the branch. `WORKSHOP_DIR=off` disables all of it.

### Keeping HQ current and running smoothly

- **Update HQ card.** Every hour HQ checks its branch on GitHub. If there's code it isn't running (pushed from a Claude Code session), one "Update HQ: N new changes" card waits under Needs you and on Telegram, listing the commits; approving it deploys them with the same wait-for-runs, health check and rollback as Einstein's ships. `/update` or Settings → "Check for update" checks now. No SSH needed.
- **Run time limits.** Every agent run ends after `RUN_TIMEOUT_MS` (20 min), Einstein's code runs after `WORKSHOP_RUN_TIMEOUT_MS` (60 min), so a hung run can't hold an agent or the workshop.
- **Workshop queue.** A second code task waits for the workshop (up to `WORKSHOP_WAIT_MS`) instead of running without it; the Working strip shows "queued for the workshop".
- **Deploys don't cut off work.** A ship, an update, or a manual run of `setup.sh` waits for runs in progress (up to 20–25 min; `FORCE=1` skips it for `setup.sh`). Runs a restart did cut off are marked lost, never "still working".
- **Auto-ship (off by default).** Settings → Einstein's workshop. When on, a change goes out without a card if the commit's own files (read from git) touch none of the guardrails (approvals, money, connectors, routers, the store, deploy, server routes, dependencies), at most `AUTO_SHIP_PER_DAY` a day. Anything else still waits for Phil.

### Usage rationing

Work is rationed by priority against each pool, so a busy month degrades gracefully instead of stopping or overspending. Signed in with the Claude plan (the default) there is no dollar pool: the plan has rolling five-hour and weekly windows, and when a run is refused with "limit reached, resets at …" HQ holds room and pause-first work until that time while Phil's own asks still run. `CLAUDE_MONTHLY_USD` applies only with an API key from a linked Console account, where the plan's monthly API credit is the pool; the xAI pool is a monthly budget for X searches and, with `GROK_MODE=api`, Grok runs (`XAI_MONTHLY_USD`); with `GROK_MODE=cli` the Grok CLI has a weekly run pool (`GROK_WEEKLY_RUNS`). Every run is costed at list price so Usage shows dollars per agent.

- **Always run:** Jarvis, Stella's team, anything Phil asks for directly.
- **Run when there's room:** briefs, holdings reviews, research. Hold at 90% of a pool.
- **Pause first:** scheduled scanners back off at 70% of a pool.

### Safety

- Nothing irreversible runs on its own. Agents ask with a fenced `approval` block; HQ queues it; Phil approves, edits or rejects. An approval whose payload names an `action` runs the registered executor on approval (`jarvis.onApproved("gmail.send", fn)` is where a connector plugs in); today the only executor is `memory.replace` for Oscar's condensing.
- Claude agents can call read-only HQ tools (`memory_search`, `web_status`, `activity_recent`, `roster`) through the Agent SDK when ticked in their settings; nothing that changes the world is a tool.
- Kill switch: pause one agent, all trading (Mayne and the on-chain team), or the whole web, from HQ or `/pause`.
- Single-user login: password (`HQ_PASSWORD`, HMAC-signed cookie) plus passkeys (WebAuthn) registered under Settings. Set `HQ_RP_ID` to the HQ domain in production.
- Per-agent approval rules let low-risk kinds (record changes, config) go through on their own under a dollar cap; money moves and trading strategies always wait for Phil.
- Every agent run, delegation, approval, decision and memory write is in the activity log. Outside content is treated as data, never as instructions; the rule is in every agent's system prompt.
- Secrets live in `.env` on the server (never committed). Wallet and brokerage keys, when they arrive, are read-only.

### HQ screens

| Screen | What Phil does there |
| --- | --- |
| Home | The approved display: status orb and level bar, clock and Rochester weather, needs-your-attention, money pulse, Joi's visuals, Jarvis core with his one recommendation and the command bar, towers for the 12 leads (lit when their team needs Phil), since-you-left, primary objective with the two secondary goals. Display off shows just the skyline. |
| Command | Chat with Jarvis by text or voice; `@stella` talks to an agent directly; `/brief`, `/status`, `/pause`, `/resume`, `/approvals`, `/usage`, `/memory`, `/help`. |
| Agent Web | The live map: every bubble shows working, idle, waiting on Phil, error or paused, plus last run and model. Tap one for its job, team, model switch, pause and a task box. Faded bubbles are not live in the current phase. |
| Needs you | Everything waiting on Phil, under one badge, in two sections. **Approve**: one inbox for every send, post, money move, record change and strategy; approve, edit or reject with a note, ask the agent about it, and look back under Decided. **To do**: things only Phil can do, raised by agents with an `attention` block (or by Phil); they wait until ticked off, oldest first, show on the home screen, reach Telegram with Done / Snooze buttons, and Jarvis reads the open ones in the morning brief. `/attention#approve` and `/attention#todo` jump to each; the old `/approvals` link forwards here. |
| Activity | Searchable record of who did what, when and why, with the prompt and reply behind each run. |
| Usage | Each plan against its pool this week, per agent; provider readiness; the schedule table. |
| Ventures | One page per venture: metrics over time with sparklines, a board of tracker records (JD PM leads and jobs, Analyzer strategies, Money holdings, Philneeds posts, Range.cool milestones…), the team's live status, what's waiting on Phil, recent activity. Agents feed it with `metric` and `record` blocks; Phil edits anything by hand. The home towers open these. |
| Always on | For a screen on a stand: say "Jarvis" (with a free Picovoice key) or clap twice to wake him, talk, he answers in his voice; the morning brief is read out when it runs; new approvals are announced and answered by voice ("approve", "reject", "later"). Keeps the screen awake. |
| Daily brief | Jarvis's morning rundown, run on a timer or on demand, with earlier briefs. Leads with data access (Monica's calendar, Stella's mail, Mantis's markets) report first and the brief is written from their reports, in Eastern time, to be heard aloud. |
| Memory | Browse and correct what the web knows; add facts; Oscar condenses on request or nightly, and the result waits in Needs you. |
| Agent settings | Per agent (from the Agent Web panel): Phil's persona template, model switch, tools, a custom schedule, and approval rules (which kinds may go through alone, up to what dollar amount). |
| Settings | Passkeys for this device, the build phase, provider readiness, notification setup. |

### Phases

The web moves phase by phase; agents fade in on the map as their phase arrives. `POST /api/phase {"phase":1}` (or a one-line setting) opens the next one. Schedules (`packages/core/src/scheduler.ts`) carry a phase too, so scouts don't fire until Phase 2.

## Deploy (cloud server)

The Claude and Grok plan sign-ins live on the box, so the simplest shape is one VPS running both apps under systemd with Postgres and Caddy in front. On a fresh Ubuntu server, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/philneeds/jarvis/main/deploy/setup.sh | DOMAIN=hq.example.com HQ_PASSWORD='a-long-one' BRANCH=main bash
```

`deploy/setup.sh` installs Node, pnpm, Postgres and Caddy, clones to `/opt/jarvis`, writes `.env`, builds, migrates, starts `jarvis-server` and `jarvis-hq` under systemd, and puts Caddy with TLS in front. Re-run it to update. Then sign in the plans once as the app user:

```bash
sudo -iu jarvis
claude login
grok login --device-auth
exit
systemctl restart jarvis-server
```

`deploy/Caddyfile` routes `/api/*` and `/ws` to the server and everything else to HQ on one domain with TLS; `deploy/docker-compose.yml` brings up Postgres and Caddy. Set `HQ_ORIGIN`, `HQ_RP_ID` and `NEXT_PUBLIC_WS_URL` to the domain. `NOTIFY_WEBHOOK_URL` (an ntfy topic) and/or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` push approvals and alerts to the phone.

### Connectors

| Connector | What it gives | Set up |
| --- | --- | --- |
| Google | Calendar (Monica) and Gmail (Stella's team): read tools, drafts without approval, Monica's direct `calendar_create_event` / `calendar_update_event` / `calendar_delete_event` on Phil's own events (guests refused), `gmail.send` and `calendar.create` with attendees as approval actions | Create an OAuth client (Web application) in Google Cloud with redirect `<HQ origin>/api/connectors/google/callback`, set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, then Settings → Connect Google |
| X | Phil's own accounts (Philneeds, Range.cool, Acres), one OAuth connection each: mentions, own posts with metrics and the DM inbox as tools; `x.post`, `x.reply` and `x.dm` as approval actions | OAuth 2.0 app in the X developer portal with redirect `<HQ origin>/api/connectors/x/callback`, set `X_CLIENT_ID` / `X_CLIENT_SECRET`, then Settings → Connect an X account (once per account) |
| Telegram | Talk to Jarvis from your phone; approvals arrive with Approve / Reject buttons | Make a bot with @BotFather, set `TELEGRAM_BOT_TOKEN` and your `TELEGRAM_CHAT_ID` |
| ntfy | Push alerts | `NOTIFY_WEBHOOK_URL` |
| Video | `video_analyze` for every agent with tools: a public YouTube link is watched by Gemini (the link goes to Gemini as it is; HQ downloads nothing) and comes back as what is said, what is shown and the on-screen text, with times. A YouTube link in Phil's own message, or a video file he sends on Telegram (up to 20 MB), is watched before anyone answers; a file is uploaded to Gemini, read, then deleted there. Instagram links are off: Phil gets one line asking for the reel as a video file on Telegram. Every video is priced with Gemini's token counter before it is sent; one that can't be priced, or would pass a cap, isn't sent. `/usage` shows the day's video spend | `GEMINI_API_KEY` from aistudio.google.com, on a project with billing on (paid tier: content isn't used to improve Google's products). Caps: `VIDEO_CAP_PER_VIDEO_USD` (default 0.50) and `VIDEO_CAP_PER_DAY_USD` (default 2.00, resets at midnight Eastern). `GEMINI_VIDEO_MODEL` (default `gemini-3.8-flash`); for a model HQ has no price for, set `GEMINI_VIDEO_PRICE_IN_USD` / `GEMINI_VIDEO_PRICE_OUT_USD` per million tokens. The reader sits behind a small interface in `packages/core/src/video.ts` (`VideoBackend`), so another video model can be added and picked with `VIDEO_BACKEND` |

A new connector is a class with `tools()` and `executors()` passed to `jarvis.addConnector(...)`; see `packages/core/src/connectors/google.ts`.

### Mayne's hard limits

Max position size, max daily loss, max open positions and an auto-stop drawdown, set on Mayne's agent page. They are checked when Mayne asks for a trade (an over-limit request is refused before Phil sees it) and again when an approved trade executes, so a limit Phil tightens while an approval waits still holds. Hitting the daily loss or the drawdown stop flips the trading kill switch until Phil clears it. Execution is paper (a ledger of open positions and realized P&L) until a wallet or exchange connector wraps the trade executor with `guard.wrap(...)`; equity can be marked by hand or by that connector.

## Develop

```bash
pnpm typecheck
pnpm test          # core: registry, blocks, Jarvis end to end on mocks, scheduler; server: API
pnpm db:generate   # after changing packages/core/src/db/schema.ts
```

## Open questions (from the scope doc)

Which Claude and Grok plans exactly; what other AI plans or keys exist; JD PM's CRM, scheduling and invoicing tools; a name and domain for HQ, push vs Telegram for approvals; the Memecoin Analyzer stack; which cloud server; how Doc gets health data.
