# Jarvis

One front door to Phil's web of 52 specialist agents across nine ventures. Phil talks to Jarvis in **HQ**, a private phone-first web app; Jarvis routes work to agents, each on the model that fits it, and anything that moves money, posts publicly or messages a customer waits for Phil's OK.

This is **Phase 0 — Foundation** of the [scope outline](https://claude.ai/artifact/DVX4ekT1tjMJuaN3je54vp): the web terminal, Jarvis, the model router (Claude + Grok, others pluggable), shared memory, the action log, the approval queue, and the five MVP screens (Command, Agent Web, Approvals, Activity log, Usage). Gate: Phil can ask Jarvis something and get an answer from a Claude agent and a Grok agent.

## Layout

```
packages/core   the runtime: agent registry (52 agents, 9 ventures), model catalog, model router,
                providers (Claude Agent SDK / API, Grok CLI / API, mock), Jarvis orchestrator,
                approvals + memory blocks, usage rationing, scheduler, Postgres schema + stores
apps/server     Hono API + websocket feed; single-user login; runs Jarvis and the scheduler
apps/hq         Next.js HQ: Home display, Command, Agent Web, Approvals, Activity, Usage (installable PWA)
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
| same, fallback | xAI API (`GROK_MODE=api`) | `XAI_API_KEY` |
| `cursor`, `higgsfield`, `chatgpt-health` | not callable from HQ yet | Jarvis reports it and asks Phil to relay |

The router tries the configured mode first and falls back to the other if it is available. Model ids: `CLAUDE_OPUS_MODEL`, `CLAUDE_SONNET_MODEL`, `GROK_MODEL`.

### Usage rationing

Both plans have caps, so work is rationed by priority instead of paying for API calls. Pools are estimates until the plans are confirmed (`CLAUDE_WEEKLY_TOKENS`, `GROK_WEEKLY_RUNS`).

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
| Approvals | One inbox for every send, post, money move, record change and strategy. Approve, edit or reject with a note. |
| Activity | Searchable record of who did what, when and why, with the prompt and reply behind each run. |
| Usage | Each plan against its pool this week, per agent; provider readiness; the schedule table. |
| Ventures | One page per venture: metrics over time with sparklines, a board of tracker records (JD PM leads and jobs, Analyzer strategies, Money holdings, Philneeds posts, Range.cool milestones…), the team's live status, what's waiting on Phil, recent activity. Agents feed it with `metric` and `record` blocks; Phil edits anything by hand. The home towers open these. |
| Daily brief | Jarvis's morning rundown, run on a timer or on demand, with earlier briefs. |
| Memory | Browse and correct what the web knows; add facts; Oscar condenses on request or nightly, and the result waits in Approvals. |
| Agent settings | Per agent (from the Agent Web panel): Phil's persona template, model switch, tools, a custom schedule, and approval rules (which kinds may go through alone, up to what dollar amount). |
| Settings | Passkeys for this device, the build phase, provider readiness, notification setup. |

### Phases

The web moves phase by phase; agents fade in on the map as their phase arrives. `POST /api/phase {"phase":1}` (or a one-line setting) opens the next one. Schedules (`packages/core/src/scheduler.ts`) carry a phase too, so scouts don't fire until Phase 2.

## Deploy (cloud server)

The Claude and Grok plan sign-ins live on the box, so the simplest shape is one VPS running both apps under systemd with Postgres and Caddy in front.

```bash
# once
claude login && grok login
pnpm install && pnpm build && pnpm db:migrate
# serve
PORT=4000 node apps/server/dist/index.js        # systemd unit 1
pnpm --filter @jarvis/hq start                   # systemd unit 2 (port 3000)
```

`deploy/Caddyfile` routes `/api/*` and `/ws` to the server and everything else to HQ on one domain with TLS; `deploy/docker-compose.yml` brings up Postgres and Caddy. Set `HQ_ORIGIN`, `HQ_RP_ID` and `NEXT_PUBLIC_WS_URL` to the domain. `NOTIFY_WEBHOOK_URL` (an ntfy topic) and/or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` push approvals and alerts to the phone.

### Connectors

| Connector | What it gives | Set up |
| --- | --- | --- |
| Google | Calendar (Monica) and Gmail (Stella's team): read tools, drafts without approval, `gmail.send` and `calendar.create` as approval actions | Create an OAuth client (Web application) in Google Cloud with redirect `<HQ origin>/api/connectors/google/callback`, set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, then Settings → Connect Google |
| X | Phil's own accounts (Philneeds, Range.cool, Acres), one OAuth connection each: mentions, own posts with metrics and the DM inbox as tools; `x.post`, `x.reply` and `x.dm` as approval actions | OAuth 2.0 app in the X developer portal with redirect `<HQ origin>/api/connectors/x/callback`, set `X_CLIENT_ID` / `X_CLIENT_SECRET`, then Settings → Connect an X account (once per account) |
| Telegram | Talk to Jarvis from your phone; approvals arrive with Approve / Reject buttons | Make a bot with @BotFather, set `TELEGRAM_BOT_TOKEN` and your `TELEGRAM_CHAT_ID` |
| ntfy | Push alerts | `NOTIFY_WEBHOOK_URL` |

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
