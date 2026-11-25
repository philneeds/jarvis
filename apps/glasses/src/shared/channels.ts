/**
 * What passes between the two halves of the app: the phone screen (ui) and the always-on half (background), which
 * owns the glasses and the link to HQ. The pairing key only ever travels screen → background, never back.
 */
export type Phase = "idle" | "listening" | "asking" | "reading";
export interface AppState {
  /** HQ's address, once set. */
  url: string;
  paired: boolean;
  phase: Phase;
  /** One line for the screen: "Connected to HQ", an error, what's happening. */
  status: string;
  /** The last thing Phil asked and the answer so far. */
  you: string;
  reply: string;
  /** Answers to spoken questions are read aloud as well as shown (Phil's switch, on the phone). */
  speak: boolean;
  /** What HQ says is switched on in Settings › Glasses, as last heard. */
  approvals: boolean;
  listen: boolean;
  /** Lines heard for the all-day memory and not yet sent to HQ. */
  unsent: number;
}
export interface Channels {
  // screen → background
  "save": { url: string; key: string };
  "test": Record<string, never>;
  "ask": { text: string };
  "talk": Record<string, never>;
  "dismiss": Record<string, never>;
  "speak": { on: boolean };
  "cards": Record<string, never>;
  // background → screen
  "state": AppState;
}
