# Jarvis on the glasses

A MentraOS miniapp for Phil's Even G2: hold to talk, the words go to Jarvis HQ, the answer shows in view.
MentraOS runs it on the phone (the glasses are the screen and the microphone).

What works, in tests with stand-in glasses: pairing with HQ, hold to talk, the answer in view a page at a time and read
aloud, approvals by voice, all-day memory, and a phone screen to pair, ask by typing and switch the voice off. It has not
run on real glasses yet.

## How it fits together

- `src/background/` — the always-on half. `controller.ts` is all the behaviour (listening → asking → reading);
  `index.ts` plugs the real glasses into it.
- `src/ui/` — the phone screen: pair with HQ, test, ask by typing.
- `src/shared/` — the link to HQ (`hq.ts`), paging for the display (`pages.ts`), and the messages between the halves.
- HQ's side is in `packages/core/src/glasses.ts` and the `/api/glasses/…` routes in `apps/server/src/app.ts`.

The glasses hold one pairing key from HQ › Settings › Glasses. It can ask Jarvis something and read the replies;
HQ accepts it for nothing else, keeps only its hash, and a new pairing replaces it.

## Build and install

```bash
pnpm --filter @jarvis/glasses build     # dist/ in the layout MentraOS expects
pnpm --filter @jarvis/glasses test
```

To put it on the phone (needs [bun](https://bun.sh) and Mentra's CLI, on a computer on the same Wi-Fi as the phone):

```bash
cd apps/glasses && bunx @mentra/miniapp-cli release
```

Scan the QR it prints from the MentraOS app (Settings → Developer settings → Mini App Development). Then open Jarvis
in MentraOS, and enter HQ's address and the pairing key from HQ › Settings › Glasses.

## On the glasses

Hold to talk · tap for the next page · double tap to clear (and stop talking).

- **Spoken replies.** The answer to a spoken question is said aloud as well as shown (MentraOS's voice). "Read answers
  aloud" on the phone screen turns it off.
- **Approvals by voice** (off until Phil turns it on in HQ › Settings › Glasses). Say "what needs me": the cards are read
  one at a time. Hold and say "approve", "reject", "next" or "stop". HQ runs only the card exactly as it was read (its
  fingerprint, as Telegram does), and never approves one that moves money, trades, ships code or updates HQ: those can
  be rejected from the glasses and are approved in HQ or Telegram.
- **All-day memory** (off until Phil turns it on there too). Between questions, the finished lines the glasses hear go
  to HQ every two minutes, sealed and kept 14 days; Lip reads them (glasses_heard) when Phil asks what was said. The
  glasses look at the switch every ten minutes, and drop anything unsent when it's turned off.

## To check on the real G2

- Which touch gestures the G2 (and the ring) send through MentraOS, and whether hold-to-talk clashes with anything.
- Whether the always-on half keeps running with the MentraOS app in the background or the phone locked.
- The page size (`src/shared/pages.ts` estimates it from the display's pixels).
- Where MentraOS keeps the app's storage (the pairing key is stored there).
- That the speaker's voice comes through the G2 (or the phone) and that the memory's listener doesn't pick it up.
- Whether two transcription listeners (a question and the all-day memory) both get every line, as the SDK says.
- How much the all-day listening costs in battery over a day.

## Not built yet

HQ hosting the install link itself, Jarvis's own (ElevenLabs) voice on the glasses, and a nightly summary of the day's
memory.
