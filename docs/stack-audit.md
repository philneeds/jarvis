# Jarvis stack audit — 7 Nov 2026

What HQ runs on, what each piece is for, what tonight's X investigation changed, and what it should cost. Prices are list prices checked on 7 Nov 2026; the Claude plan tier is an assumption until Phil confirms it.

## 1. What's in use, and why

| Piece | Used for | Cost today | Verdict |
| --- | --- | --- | --- |
| **Claude plan** (Max, tier unconfirmed) via the Claude Agent SDK | Jarvis himself and 36 of 53 agents (11 Opus, 25 Sonnet): planning, synthesis, the brief, every tool-using agent. Since 15 Jun 2026 Agent SDK runs draw on a monthly credit on the plan (Pro $20, Max 5x $100, Max 20x $200) instead of the chat limits. | Already paid | **Keep.** The core of the system. The credit is the real cap: HQ now tracks every run in dollars against it. |
| **SuperGrok** ($30/mo) via the Grok Build CLI | 15 scouts and drafters (Marcus, House, Exxon, Altman, Armstrong, Pentoshi, Tux, Cat, Ansem, Claw, Lucas, Boo, ncrypt, Jeff, Intern). Also Phil's own Grok Bot in the X app. | $30/mo | **Drop for HQ.** The CLI is a coding tool: no X search, no HQ tools, five-minute timeouts, turn-limit narration. It was chosen for X access it doesn't have. Keep the subscription only if Phil wants Grok Bot for himself. |
| **xAI API** (console.x.ai, prepaid credits) | X search for every agent (`x_search`, account pulls into brains). The only route to X that works from a server: X blocks the public timeline for datacenter addresses (429), and the CLI answers "X search is unavailable". | $5 per 1,000 posts read + ~$1.25/$2.50 per 1M tokens. ~15¢ per 25-post pull; $1–3/day with all scouts active. | **Add, with a $30/mo budget** (`XAI_MONTHLY_USD`). HQ meters every search. |
| **ElevenLabs** | Jarvis's spoken replies on Telegram (Flash v2.5, 1.25x). The key has no speech-to-text permission, so transcription doesn't use it. | Free tier (10k credits ≈ 10 min of speech/mo) or Starter $5–6 | **Keep on free until it runs dry**, then Starter. |
| **Groq** | Voice-note transcription (Whisper large v3 turbo). | Free tier, verified working | **Keep.** |
| **OpenAI** | Nothing (optional transcription fallback). | $0 | Leave unset. |
| **ChatGPT Health** | Was the model for Doc's team (Gordon, Metro, Sean). Phil doesn't use it. | — | **Removed from the roster**: those three now run on Sonnet with Doc's Apple Health tools. |
| **Cursor** (Jason 2.0) | Phil's own coding sessions. HQ never calls it. | Phil's choice | Not an HQ cost. |
| **DigitalOcean droplet** (134.199.206.190, Ubuntu 24.04, 28 GB disk) | The whole of HQ: server, HQ web app, Postgres, Caddy. | ~$6–12/mo | **Keep.** Memory was 17% used; fine for now. |
| Postgres, Caddy, sslip.io domain, systemd | Database, TLS, hostname. | $0 | Keep. |
| **Telegram** | Chat with Jarvis, voice notes, alerts, deck delivery. | $0 | Keep. |
| **Google** (Gmail, Calendar, Drive) | Monica, Oscar, Stella's crew; nightly backup copy to Drive. | $0 | Reconnect is on Phil's list (Drive backups need it). |
| **GoHighLevel** | JD PM's CRM: leads, conversations, pipeline, invoices. Writes wait for approval. | Part of the JD PM subscription Phil already pays | Keep. Token on Phil's list. |
| **Kubera** | Net worth and holdings for Munger, Buffett, Mayne. | Phil's existing plan | Keep. Key on Phil's list. |
| **Robinhood MCP** | Holdings and orders (orders always wait for approval). | $0 | Keep. "Connect Robinhood" on Phil's list. |
| **Hyperliquid, Discord, GitHub** | Market data; the biotech server; the repos. Read-only. | $0 | Keep. |
| **healthchecks.io** | Downtime alert to Telegram. | Free | Keep. URL on Phil's list. |

## 2. What tonight proved about X

1. The Grok Build CLI on the server has no X search. Asked to search X it answered "X search is unavailable" in 7 seconds, one turn, no tool used. Every Lucas run that "pulled tweets" was fetching x.com pages by hand and being blocked (HTTP 429, error 1015).
2. X blocks the public timeline read (the embed service) for the droplet's address: 429 instantly, every time.
3. The Grok Bot that reads X perfectly in the X app is a consumer product with X's data behind it. It has no API. The xAI API is the same company's X search for programs, billed per use, separate from the SuperGrok subscription.

So X reads now go through xAI's API for every model, once `XAI_API_KEY` is in `/opt/jarvis/.env`. Account pulls (`pull @x into House's brain`, `/brain house from @x`) use its account filter and file one memory item per post.

## 3. Recommendation

**Lean stack:** Claude plan + xAI credits for X + the free tier of everything else.

1. **Put the xAI key in** (console.x.ai, load $10–20 of credit). This is the only change that turns X on. Budget `XAI_MONTHLY_USD=30`; HQ holds scouts at 70% and research at 90% of it.
2. **Move the 15 Grok agents onto Claude Sonnet** with one line in `.env`: `GROK_AGENTS_MODEL=claude-sonnet`. They gain HQ's tools (X search, memory, GitHub, Discord, Hyperliquid) directly instead of through pre-fetched blocks, lose the five-minute timeouts, and cost about $15/mo of the Claude credit at their current schedules. Per-agent overrides in HQ still win, so Boo can stay on Grok (via the API) if his X voice matters.
3. **Then drop SuperGrok** ($30/mo), unless Phil wants Grok Bot in the X app for himself. If he keeps it, HQ no longer depends on it.
4. **Confirm the Claude tier** and set `CLAUDE_MONTHLY_USD` to its credit (100 for Max 5x, 200 for Max 20x). The Usage page now shows dollars spent against it, per agent.

Alternative if the Claude credit is Max 5x and runs tight: `GROK_MODE=api` instead of step 2 keeps the scouts on Grok through the xAI API (about $20/mo in tokens on the xAI budget) with the same reliability gain. The Grok API path has no HQ tools, so Sonnet is the better choice when the credit allows.

## 4. Projected monthly cost

Estimates at list prices from the current schedules (daily brief, Jarvis conversations at ~20 messages/day, 9 daily and 10 weekly Claude routines, 5 weekday openers, two 4-hourly scanners, 5 X-facing scouts/day) with prompt caching on the Agent SDK side.

| Item | Now | Lean stack |
| --- | --- | --- |
| Claude plan (credit use, not a bill) | ~$60–90 of credit | ~$75–105 of credit (scouts added). Fits Max 20x easily; tight on Max 5x, which the Usage page will show. |
| SuperGrok | $30 | $0 (or $30 if kept for Grok Bot) |
| xAI credits | $0 (and no X) | $15–40, capped by `XAI_MONTHLY_USD` |
| ElevenLabs | $0 | $0–6 |
| Groq, Telegram, Google, Robinhood, Hyperliquid, Discord, GitHub, healthchecks | $0 | $0 |
| Droplet | ~$6–12 | ~$6–12 |
| **Cash out of pocket, beyond the Claude plan** | **~$36–42** | **~$21–58** (lower end without SuperGrok; the xAI spend is the variable) |

The xAI line is the only one that scales with activity, and it's pay-as-you-go against credit Phil loads, so it can never run past what's loaded.

## 4b. Einstein as HQ's engineer (added later the same night)

Einstein now does what Claude Code has been doing here: reads, changes and tests HQ's code in a workshop copy, diagnoses from the server log and the database, and ships each change through one approval card with automatic rollback (README, "Einstein's workshop"). He runs on Claude Fable 5.1 by default ($10 / $50 per 1M tokens, about 2.5x Opus; Opus is one dropdown away on his agent page). A typical code task is $2–8 of the Claude credit; the weekly review about $1. Budget $30–60/mo of credit for him if he's used daily. Needs on Phil's side: a fine-grained GitHub token (Contents read and write, jarvis repo only) in `.env` as `GITHUB_PUSH_TOKEN`.

## 5. What changed in the backend tonight

- X search through xAI's Responses API (`packages/core/src/xai.ts`), used by `x_search` for every agent, by account pulls, and pre-fetched into Grok agents' tasks when the task is about X. Costed per search and logged to Usage.
- Jarvis pulls an X account into an agent's brain himself (`pull @x into House's brain`, `/brain house from @x`); the planner can no longer route that to a research run.
- The Grok CLI is told plainly it has no X search; its rules no longer send it to fetch x.com.
- Usage pools are dollars: Claude's monthly Agent SDK credit (`CLAUDE_MONTHLY_USD`), an xAI monthly budget (`XAI_MONTHLY_USD`); Grok CLI runs stay weekly. Cost estimates updated to current prices (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, grok-4.x $1.25/$2.50). Usage page shows cost per agent.
- `GROK_AGENTS_MODEL` switch; Grok API default model `grok-4.7`.
- Doc's team (Gordon, Metro, Sean) off ChatGPT Health onto Sonnet.
- "X search" is a readiness connection: the Build card shows who lacks it until the key is in. Settings shows the X search status. `deploy/diag.sh` tests the key with a one-post search.

## 6. Phil's side, in order

1. xAI key: create at console.x.ai, load credit, paste on the server, run `bash /opt/jarvis/deploy/diag.sh`, expect HTTP 200 in the xAI section.
2. Say which Claude tier it is; set `CLAUDE_MONTHLY_USD` accordingly (default 100).
3. Decide on SuperGrok. To move the scouts first: `GROK_AGENTS_MODEL=claude-sonnet` in `.env`, restart `jarvis-server`.
4. The existing list: Google reconnect, Robinhood connect, healthchecks URL, GoHighLevel token, Discord bot, GitHub token, Kubera, Apple Health, Chainstack, iPad, phase 2 on Monday.
