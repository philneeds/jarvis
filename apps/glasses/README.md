# Jarvis on the glasses

A MentraOS miniapp for Phil's Even G2: hold to talk, the words go to Jarvis HQ, the answer shows in view.
MentraOS runs it on the phone (the glasses are the screen and the microphone).

**This is the bones.** What works, in tests with stand-in glasses: pairing with HQ, hold to talk, the answer in view a
page at a time, a phone screen to pair and to ask by typing. It has not run on real glasses yet.

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

Hold to talk · tap for the next page · double tap to clear.

## To check on the real G2

- Which touch gestures the G2 (and the ring) send through MentraOS, and whether hold-to-talk clashes with anything.
- Whether the always-on half keeps running with the MentraOS app in the background or the phone locked.
- The page size (`src/shared/pages.ts` estimates it from the display's pixels).
- Where MentraOS keeps the app's storage (the pairing key is stored there).

## Not built yet

Spoken replies, all-day listening that feeds Jarvis's memory, approvals from the glasses, and HQ hosting the install
link itself.
