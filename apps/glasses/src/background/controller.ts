import type { AppState, Phase } from "../shared/channels";
import { Hq, hqUrl, type Fetch, type HqConfig, type Reply } from "../shared/hq";
import { G2, paginate, type Display } from "../shared/pages";

/**
 * Jarvis on the glasses, as one small state machine: hold to talk → the words show as they're heard → they go to HQ →
 * the answer shows in view, a page at a time. It runs in the app's always-on half and touches the glasses only through
 * `Glass`, so the same logic is tested here with stand-ins and driven by the real session in index.ts.
 *
 * The bones only: one question at a time, text answers. Not here yet: spoken replies, all-day listening for Jarvis's
 * memory, approvals.
 */
export interface Glass {
  /** The display's size in pixels, once the glasses say. */
  display(): Display | undefined;
  /** Put text in view, with one short line under it (the page count, "asking…"). */
  show(body: string, footer: string): void;
  clear(): void;
  /** Start hearing Phil; returns how to stop. */
  listen(on: (heard: { text: string; isFinal: boolean }) => void): () => void;
  store: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  /** Tell the phone screen where things stand. */
  notify(state: AppState): void;
  fetch: Fetch;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

const URL_KEY = "hq.url", KEY_KEY = "hq.key";
/** How long silence lasts before what was heard is taken as the question, and before an answer leaves the view. */
export const SILENCE_MS = 2500, NOTHING_HEARD_MS = 10_000, LINGER_MS = 40_000, NOTE_MS = 6000;

export class Controller {
  private cfg?: HqConfig;
  private phase: Phase = "idle";
  private status = "Not paired with HQ yet";
  private you = "";
  private reply = "";
  private pages: string[] = [];
  private page = 0;
  private working = false;
  /** Each new question takes the next number; an older one that is still waiting on HQ sees it changed and stops. */
  private run = 0;
  private heard = "";
  private stopListening?: () => void;
  private timer?: unknown;
  private timers: NonNullable<Glass["timers"]>;

  constructor(private glass: Glass) {
    this.timers = glass.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  state(): AppState { return { url: this.cfg?.url ?? "", paired: !!this.cfg, phase: this.phase, status: this.status, you: this.you, reply: this.reply }; }
  private tell() { this.glass.notify(this.state()); }
  private after(ms: number, fn: () => void) { if (this.timer !== undefined) this.timers.clear(this.timer); this.timer = this.timers.set(fn, ms); }
  private hq() { return new Hq(this.cfg!, this.glass.fetch); }

  async init(): Promise<void> {
    const [url, key] = await Promise.all([this.glass.store.get(URL_KEY), this.glass.store.get(KEY_KEY)]);
    if (url && key) { this.cfg = { url, key }; this.status = "Paired with HQ"; }
    this.tell();
  }

  /** From the phone screen: HQ's address and the pairing key. Kept only once HQ accepts them. */
  async save(url: string, key: string): Promise<void> {
    try {
      const next = { url: hqUrl(url), key: key.trim() || this.cfg?.key || "" };
      if (!next.key) throw new Error("enter the pairing key from HQ › Settings › Glasses");
      await new Hq(next, this.glass.fetch).ping();
      await this.glass.store.set(URL_KEY, next.url);
      await this.glass.store.set(KEY_KEY, next.key);
      this.cfg = next;
      this.status = "Paired with HQ";
    } catch (e) { this.status = `Not saved: ${(e as Error).message}`; }
    this.tell();
  }

  async test(): Promise<void> {
    if (!this.cfg) this.status = "Not paired with HQ yet";
    else try { await this.hq().ping(); this.status = "Connected to HQ"; } catch (e) { this.status = (e as Error).message; }
    this.tell();
  }

  /** Hold to talk (or the phone's Talk button). While listening, the same gesture cancels. */
  talk(): void {
    if (this.phase === "listening") return this.dismiss();
    this.run++;
    if (!this.cfg) return this.note("Open Jarvis on your phone and pair it with HQ first.");
    this.phase = "listening"; this.heard = ""; this.you = ""; this.reply = ""; this.status = "Listening";
    this.glass.show("Listening…", "");
    this.stopListening = this.glass.listen((h) => this.hear(h));
    this.after(NOTHING_HEARD_MS, () => this.dismiss());
    this.tell();
  }

  private hear(h: { text: string; isFinal: boolean }): void {
    if (this.phase !== "listening") return;
    const text = h.text.trim();
    if (text) { this.heard = text; this.glass.show(text, "listening…"); }
    if (h.isFinal && this.heard) { void this.ask(this.heard, true); return; }
    // No more words for a moment: what was heard is the question.
    if (this.heard) this.after(SILENCE_MS, () => void this.ask(this.heard, true));
  }

  private stopHearing() { this.stopListening?.(); this.stopListening = undefined; }

  /** Send a question to Jarvis and show the answer as it arrives (first "on it", then the answer). */
  async ask(text: string, spoken: boolean): Promise<void> {
    const q = text.trim();
    if (!q) return;
    this.stopHearing();
    const my = ++this.run;
    if (!this.cfg) return this.note("Open Jarvis on your phone and pair it with HQ first.");
    this.phase = "asking"; this.you = q; this.reply = ""; this.status = "Asking Jarvis"; this.working = true;
    this.pages = paginate(q, this.glass.display() ?? G2); this.page = 0;
    this.draw();
    this.after(15 * 60_000, () => this.dismiss());
    this.tell();
    try {
      const hq = this.hq();
      const id = await hq.ask(q, spoken);
      const all: Reply[] = [];
      // Up to 15 minutes of waiting on a slow agent; HQ holds each call until something new arrives.
      for (let i = 0; i < 45 && my === this.run; i++) {
        const r = await hq.replies(id, all.length, 20);
        if (my !== this.run) return;
        if (r.replies.length) {
          all.push(...r.replies);
          const latest = all[all.length - 1]!;
          this.reply = all.map((x) => `${x.who}: ${x.text}`).join("\n\n");
          this.phase = "reading"; this.status = r.done ? "Answered" : "Waiting for more";
          this.working = !r.done;
          this.pages = paginate(latest.who === "Jarvis" ? latest.text : `${latest.who}: ${latest.text}`, this.glass.display() ?? G2); this.page = 0;
          this.draw();
          this.tell();
        }
        if (r.done) { this.working = false; if (!all.length) return this.note("Jarvis had nothing to say to that."); this.draw(); this.after(LINGER_MS, () => this.dismiss()); return; }
      }
    } catch (e) {
      if (my !== this.run) return;
      this.status = (e as Error).message;
      this.note(this.status);
    }
  }

  private draw(): void {
    const n = this.pages.length;
    const footer = n > 1 ? `${this.page + 1}/${n}${this.page < n - 1 ? " · tap for more" : ""}` : this.working ? "…" : "";
    this.glass.show(this.pages[this.page] ?? "", footer);
  }

  /** A short message in view that clears itself. */
  private note(text: string): void {
    this.stopHearing();
    this.phase = "reading"; this.working = false; this.status = text;
    this.pages = paginate(text, this.glass.display() ?? G2); this.page = 0;
    this.draw();
    this.after(NOTE_MS, () => this.dismiss());
    this.tell();
  }

  next(): void {
    if (this.phase !== "reading" && this.phase !== "asking") return;
    if (this.page >= this.pages.length - 1) { if (this.phase === "reading" && !this.working) this.dismiss(); return; }
    this.page++; this.draw();
    if (!this.working) this.after(LINGER_MS, () => this.dismiss());
  }
  prev(): void {
    if ((this.phase !== "reading" && this.phase !== "asking") || this.page === 0) return;
    this.page--; this.draw();
    if (!this.working) this.after(LINGER_MS, () => this.dismiss());
  }

  /** Clear the view and stop whatever was going on. An answer still on its way is dropped from view, not from HQ. */
  dismiss(): void {
    this.run++;
    this.stopHearing();
    if (this.timer !== undefined) { this.timers.clear(this.timer); this.timer = undefined; }
    this.phase = "idle"; this.working = false; this.pages = []; this.page = 0;
    if (this.cfg) this.status = "Paired with HQ";
    this.glass.clear();
    this.tell();
  }

  /** The glasses' touch gestures (and the ring's). To confirm on the real G2: which of these it sends. */
  touch(kind: string): void {
    if (kind === "long_press") this.talk();
    else if (kind === "single_tap" || kind === "swipe_down") this.next();
    else if (kind === "swipe_up") this.prev();
    else if (kind === "double_tap") this.dismiss();
  }
}
