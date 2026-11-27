import type { AppState, Phase } from "../shared/channels";
import { Hq, HqError, hqUrl, type Card, type Fetch, type HqConfig, type HqOptions, type Reply } from "../shared/hq";
import { G2, paginate, type Display } from "../shared/pages";

/**
 * Jarvis on the glasses, as one small state machine: hold to talk → the words show as they're heard → they go to HQ →
 * the answer shows in view, a page at a time, and is read aloud. It runs in the app's always-on half and touches the
 * glasses only through `Glass`, so the same logic is tested here with stand-ins and driven by the real session in
 * index.ts.
 *
 * Three things beyond asking, two of them only once Phil switches them on in HQ › Settings › Glasses:
 *  - Spoken replies (his switch, on the phone): the answer to a spoken question is said as well as shown.
 *  - Approvals: "what needs me" reads the waiting cards one at a time; "approve", "reject" or "next" decides each.
 *    HQ approves only the card exactly as it was read, and never one that moves money, trades or changes code or HQ.
 *  - All-day memory: between questions, what the glasses hear goes to HQ every two minutes, for Jarvis to recall.
 */
export interface Glass {
  /** The display's size in pixels, once the glasses say. */
  display(): Display | undefined;
  /** Put text in view, with one short line under it (the page count, "asking…"). */
  show(body: string, footer: string): void;
  clear(): void;
  /** Start hearing Phil for a question; returns how to stop. */
  listen(on: (heard: { text: string; isFinal: boolean }) => void): () => void;
  /** Hear everything, all day, for the memory (its own subscription, alongside a question's); returns how to stop. */
  hearAll?(on: (heard: { text: string; isFinal: boolean }) => void): () => void;
  /** Say something aloud; resolves when it is finished or cut off. */
  say?(text: string): Promise<void>;
  /** Stop whatever is being said. */
  hush?(): void;
  store: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  /** Tell the phone screen where things stand. */
  notify(state: AppState): void;
  fetch: Fetch;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  now?(): number;
}

const URL_KEY = "hq.url", KEY_KEY = "hq.key", SPEAK_KEY = "speak";
/** How long silence lasts before what was heard is taken as the question, and before an answer leaves the view. */
export const SILENCE_MS = 2500, NOTHING_HEARD_MS = 10_000, LINGER_MS = 40_000, NOTE_MS = 6000;
/** A card stays up longer than an answer: it waits on a decision. */
export const CARD_MS = 90_000;
/** The all-day memory is sent this often; HQ's switches are looked at again every fifth time (ten minutes). */
export const FLUSH_MS = 120_000;
/** After a spoken question or Jarvis's own voice, how long the memory ignores what it hears (the tail arrives late). */
export const QUIET_MS = 4000;
const RECHECK_EVERY = 5, MAX_UNSENT = 500, SEND_AT = 40;

/** Spoken commands handled on the glasses, never sent to Jarvis as a question. Whole utterances only. */
const CARDS_Q = /^(?:(?:ok(?:ay)?|hey),? )?(?:jarvis,? )?(?:what(?:'s| is)? (?:waiting|pending)(?: (?:on|for) me)?|what needs me|what do you need from me|(?:any|show(?: me)?|read(?: me)?)(?: the| my)? (?:approvals|cards)|approvals|cards)[\s.?!]*$/i;
const APPROVE = /^(?:yes,? )?approved?(?: it| that| this(?: one)?)?[\s.!]*$/i;
const REJECT = /^(?:no,? )?(?:reject(?:ed)?|deny|decline)(?: it| that| this(?: one)?)?[\s.!]*$/i;
const SKIP = /^(?:next|skip)(?: one| card| it)?[\s.!]*$/i;
const STOP = /^(?:stop|done|cancel|that's all|that is all)[\s.!]*$/i;

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
  private speakOn = true;
  private speaking = false;
  private opts: HqOptions = { approvals: false, listen: false };
  /** The cards being gone through, and which one is in view. */
  private cards?: Card[];
  private card = 0;
  private cardsSpoken = false;
  /** All-day memory: what was heard and not sent yet, the subscription, the clock that sends it. */
  private unsent: { at: string; text: string }[] = [];
  private stopAll?: () => void;
  private tickTimer?: unknown;
  private ticks = 0;
  private sending = false;

  constructor(private glass: Glass) {
    this.timers = glass.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }
  private now() { return this.glass.now?.() ?? Date.now(); }

  state(): AppState {
    return { url: this.cfg?.url ?? "", paired: !!this.cfg, phase: this.phase, status: this.status, you: this.you, reply: this.reply, speak: this.speakOn, approvals: this.opts.approvals, listen: this.opts.listen, unsent: this.unsent.length };
  }
  private tell() { this.glass.notify(this.state()); }
  private after(ms: number, fn: () => void) { if (this.timer !== undefined) this.timers.clear(this.timer); this.timer = this.timers.set(fn, ms); }
  private hq() { return new Hq(this.cfg!, this.glass.fetch); }

  async init(): Promise<void> {
    const [url, key, speak] = await Promise.all([this.glass.store.get(URL_KEY), this.glass.store.get(KEY_KEY), this.glass.store.get(SPEAK_KEY)]);
    this.speakOn = speak !== "off";
    if (url && key) { this.cfg = { url, key }; this.status = "Paired with HQ"; await this.refresh(); this.startClock(); }
    this.tell();
  }

  /** From the phone screen: HQ's address and the pairing key. Kept only once HQ accepts them. */
  async save(url: string, key: string): Promise<void> {
    try {
      const next = { url: hqUrl(url), key: key.trim() || this.cfg?.key || "" };
      if (!next.key) throw new Error("enter the pairing key from HQ › Settings › Glasses");
      const opts = await new Hq(next, this.glass.fetch).ping();
      await this.glass.store.set(URL_KEY, next.url);
      await this.glass.store.set(KEY_KEY, next.key);
      this.cfg = next;
      this.status = "Paired with HQ";
      this.apply(opts);
      this.startClock();
    } catch (e) { this.status = `Not saved: ${(e as Error).message}`; }
    this.tell();
  }

  async test(): Promise<void> {
    if (!this.cfg) this.status = "Not paired with HQ yet";
    else try { this.apply(await this.hq().ping()); this.status = "Connected to HQ"; } catch (e) { this.status = (e as Error).message; }
    this.tell();
  }

  /** The phone screen's switch for reading answers aloud. */
  async setSpeak(on: boolean): Promise<void> {
    this.speakOn = on;
    if (!on) this.hushNow();
    await this.glass.store.set(SPEAK_KEY, on ? "on" : "off");
    this.tell();
  }

  // ---- HQ's switches and the all-day memory ---------------------------------------------------------------------

  /** Ask HQ what is switched on; a failure leaves things as they were (no signal is not "off"). */
  private async refresh(): Promise<void> {
    if (!this.cfg) return;
    try { this.apply(await this.hq().ping()); } catch { /* unreachable: keep the last known switches */ }
  }
  private apply(o: HqOptions): void {
    this.opts = o;
    if (o.listen && this.cfg) this.startAllDay(); else this.stopAllDay();
    if (!o.approvals && this.cards) { this.cards = undefined; if (this.phase === "reading") this.dismiss(); }
  }
  /**
   * The two-minute clock runs for as long as the glasses are paired, memory on or off: it is also what looks at
   * HQ's switches again (every fifth turn), which is how a memory turned on in Settings ever starts.
   */
  private startClock(): void {
    if (this.tickTimer === undefined && this.cfg) this.tickTimer = this.timers.set(() => void this.tick(), FLUSH_MS);
  }
  private startAllDay(): void {
    if (!this.stopAll && this.glass.hearAll) this.stopAll = this.glass.hearAll((h) => this.overheard(h));
  }
  /** Turned off in HQ: the mic is let go, and what was heard and not sent is dropped, not kept on the phone. */
  private stopAllDay(): void {
    this.stopAll?.(); this.stopAll = undefined;
    this.unsent = [];
  }
  /** Nothing goes to the memory until this moment: a question's own words and Jarvis's voice arrive a beat late. */
  private quietUntil = 0;
  private lastAsked = "";
  private hushMemory(ms = QUIET_MS) { this.quietUntil = Math.max(this.quietUntil, this.now() + ms); }
  private static same(a: string, b: string) { const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); return !!n(a) && n(a) === n(b); }
  /** A line for the memory: only finished ones, never a question to Jarvis (that's in the chat) or Jarvis's own voice. */
  private overheard(h: { text: string; isFinal: boolean }): void {
    const text = h.text.trim();
    if (!h.isFinal || !text || !this.opts.listen || this.phase === "listening" || this.speaking) return;
    // The question just asked reaches this listener too, sometimes after the asking has begun; so does the tail of
    // what Jarvis said aloud.
    if (this.now() < this.quietUntil || Controller.same(text, this.lastAsked)) return;
    this.unsent.push({ at: new Date(this.now()).toISOString(), text });
    if (this.unsent.length > MAX_UNSENT) this.unsent.splice(0, this.unsent.length - MAX_UNSENT);
    if (this.unsent.length >= SEND_AT) void this.flush();
  }
  private async tick(): Promise<void> {
    this.tickTimer = undefined;
    // The next turn is booked first: a send or a look that never comes back must not stop the clock.
    this.startClock();
    await this.flush();
    // Every ten minutes, look again at what HQ has switched on (memory turned on in Settings starts here).
    if (++this.ticks % RECHECK_EVERY === 0) { await this.refresh(); this.tell(); }
  }
  /** Send what was heard. Kept on the phone when HQ can't be reached; dropped when HQ says the memory is off. */
  async flush(): Promise<void> {
    if (!this.cfg || this.sending || !this.unsent.length) return;
    this.sending = true;
    const batch = this.unsent.slice(0, MAX_UNSENT);
    try {
      await this.hq().heard(batch);
      // Exactly the lines that went, wherever they sit now: more may have come in, and trimmed the list, meanwhile.
      const sent = new Set(batch);
      this.unsent = this.unsent.filter((x) => !sent.has(x));
    } catch (e) {
      if (e instanceof HqError && e.status === 403) { this.opts = { ...this.opts, listen: false }; this.stopAllDay(); }
    } finally { this.sending = false; this.tell(); }
  }

  // ---- Speaking ---------------------------------------------------------------------------------------------------

  private async speak(text: string): Promise<void> {
    if (!this.speakOn || !this.glass.say || !text.trim()) return;
    this.speaking = true;
    try { await this.glass.say(text); } catch { /* a voice that fails leaves the text in view */ } finally { this.speaking = false; this.hushMemory(); }
  }
  private hushNow(): void { if (this.speaking) { this.glass.hush?.(); this.hushMemory(); } this.speaking = false; }

  // ---- Asking -----------------------------------------------------------------------------------------------------

  /** Hold to talk (or the phone's Talk button). While listening, the same gesture cancels. */
  talk(): void {
    if (this.phase === "listening") return this.dismiss();
    this.run++;
    this.hushNow();
    if (!this.cfg) return this.note("Open Jarvis on your phone and pair it with HQ first.");
    this.phase = "listening"; this.heard = ""; this.you = ""; this.status = "Listening";
    if (!this.cards) this.reply = "";
    this.glass.show(this.cards ? "Listening… (approve, reject, next or stop)" : "Listening…", "");
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
    // The pause timer that would have sent these same words is done with: left running, it fired while a card was
    // being approved and sent the approval a second time ("Nothing ran" for a card that had run).
    if (this.timer !== undefined) { this.timers.clear(this.timer); this.timer = undefined; }
    if (spoken) { this.lastAsked = q; this.hushMemory(); }
    // Spoken commands for the cards are handled here and never reach Jarvis.
    if (this.cards && this.cfg) {
      if (APPROVE.test(q)) return this.decideCard("approved");
      if (REJECT.test(q)) return this.decideCard("rejected");
      if (SKIP.test(q)) return this.moveCard(1);
      if (STOP.test(q)) return this.dismiss();
    }
    if (CARDS_Q.test(q)) return this.openCards(spoken);
    this.cards = undefined;
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
      let said = false;
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
          // Spoken back: each answer as it lands (not "on it" or progress lines), only for a question that was spoken.
          if (spoken) for (const x of r.replies.filter((x) => x.kind === "final")) { said = true; await this.speak(x.who === "Jarvis" ? x.text : `${x.who} says: ${x.text}`); if (my !== this.run) return; }
        }
        if (r.done) {
          this.working = false;
          if (!all.length) return this.note("Jarvis had nothing to say to that.");
          // Nothing was marked final (an older HQ, or only a progress line): say the last thing that came.
          if (spoken && !said) { const last = all[all.length - 1]!; await this.speak(last.who === "Jarvis" ? last.text : `${last.who} says: ${last.text}`); if (my !== this.run) return; }
          this.draw(); this.after(LINGER_MS, () => this.dismiss()); return;
        }
      }
    } catch (e) {
      if (my !== this.run) return;
      this.status = (e as Error).message;
      this.note(this.status);
    }
  }

  // ---- Cards waiting on Phil --------------------------------------------------------------------------------------

  private async openCards(spoken: boolean): Promise<void> {
    const my = ++this.run;
    if (!this.cfg) return this.note("Open Jarvis on your phone and pair it with HQ first.");
    this.phase = "asking"; this.working = true; this.status = "Getting your cards";
    this.glass.show("Getting your cards…", ""); this.tell();
    try {
      const cards = await this.hq().cards();
      if (my !== this.run) return;
      if (!cards.length) { this.cards = undefined; this.note("Nothing is waiting on you."); if (spoken) await this.speak("Nothing is waiting on you."); return; }
      this.cards = [...cards]; this.card = 0; this.cardsSpoken = spoken;
      await this.showCard();
    } catch (e) {
      if (my !== this.run) return;
      this.cards = undefined;
      // Switched off in Settings: say how to turn it on, plainly.
      this.note(e instanceof HqError && e.status === 403 ? "Approvals from the glasses are off. Turn them on in HQ › Settings › Glasses." : (e as Error).message);
    }
  }
  private async showCard(): Promise<void> {
    const c = this.cards![this.card]!, n = this.cards!.length;
    this.phase = "reading"; this.working = false; this.status = `Card ${this.card + 1} of ${n}`;
    this.you = ""; this.reply = `${c.who}: ${c.title}\n${c.text}${c.why ? `\n${c.why}` : ""}`;
    this.pages = paginate(`${this.card + 1}/${n} ${c.who}: ${c.title}\n${c.text}${c.why ? `\n${c.why}` : ""}`, this.glass.display() ?? G2); this.page = 0;
    this.draw();
    this.after(CARD_MS, () => this.dismiss());
    this.tell();
    if (this.cardsSpoken) await this.speak(`${n > 1 ? `Card ${this.card + 1} of ${n}. ` : ""}${c.who} asks: ${c.title}. ${c.approvable ? "Hold to say approve, reject or next." : "This one you approve in HQ or Telegram. Hold to say reject or next."}`);
  }
  private async moveCard(step: number): Promise<void> {
    if (!this.cards) return;
    const next = this.card + step;
    if (next >= this.cards.length) { this.cards = undefined; this.note("That was the last card."); if (this.cardsSpoken) await this.speak("That was the last card."); return; }
    this.card = next;
    await this.showCard();
  }
  private async decideCard(decision: "approved" | "rejected"): Promise<void> {
    const c = this.cards?.[this.card];
    if (!c) return;
    // Said on the glasses, not left to HQ: the card stays in view so he can reject or move on.
    if (decision === "approved" && !c.approvable) {
      this.phase = "reading"; this.working = false;
      this.glass.show(`${c.title}\n${c.why ?? "Approve this one in HQ or Telegram."}`, "say reject or next");
      this.after(CARD_MS, () => this.dismiss());
      if (this.cardsSpoken) await this.speak("This one you approve in HQ or Telegram.");
      return;
    }
    const my = ++this.run;
    this.phase = "asking"; this.working = true; this.status = decision === "approved" ? "Approving" : "Rejecting";
    this.glass.show(`${decision === "approved" ? "Approving" : "Rejecting"}: ${c.title}`, "…"); this.tell();
    try {
      await this.hq().decide(c, decision);
      if (my !== this.run) return;
      const said = `${decision === "approved" ? "Approved" : "Rejected"}: ${c.title}`;
      this.glass.show(said, ""); this.status = said; this.tell();
      if (this.cardsSpoken) await this.speak(decision === "approved" ? "Approved." : "Rejected.");
      if (my !== this.run) return;
      this.cards!.splice(this.card, 1);
      if (!this.cards!.length) { this.cards = undefined; return this.note(`${said}. Nothing else is waiting.`); }
      if (this.card >= this.cards!.length) this.card = 0;
      await this.showCard();
    } catch (e) {
      if (my !== this.run) return;
      // Changed or already decided: nothing ran. Said, and the card stays so he can move on.
      this.phase = "reading"; this.working = false; this.status = (e as Error).message;
      this.pages = paginate(`${(e as Error).message.replace(/^HQ said: /, "")}`, this.glass.display() ?? G2); this.page = 0;
      this.draw(); this.after(CARD_MS, () => this.dismiss()); this.tell();
      if (this.cardsSpoken) await this.speak("Nothing ran. It's on the glasses.");
    }
  }

  // ---- The view -----------------------------------------------------------------------------------------------------

  private draw(): void {
    const n = this.pages.length;
    const more = n > 1 ? `${this.page + 1}/${n}${this.page < n - 1 ? " · tap for more" : ""}` : "";
    const cardHint = this.cards ? (this.cards[this.card]?.approvable ? "hold: approve / reject / next" : "hold: reject / next") : "";
    const footer = this.cards && this.phase === "reading" ? [more, cardHint].filter(Boolean).join(" · ") : more || (this.working ? "…" : "");
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
    if (this.page >= this.pages.length - 1) {
      // On a card's last page a tap moves to the next card, as "next" does.
      if (this.cards && this.phase === "reading") { void this.moveCard(1); return; }
      if (this.phase === "reading" && !this.working) this.dismiss();
      return;
    }
    this.page++; this.draw();
    if (!this.working) this.after(this.cards ? CARD_MS : LINGER_MS, () => this.dismiss());
  }
  prev(): void {
    if ((this.phase !== "reading" && this.phase !== "asking") || this.page === 0) return;
    this.page--; this.draw();
    if (!this.working) this.after(this.cards ? CARD_MS : LINGER_MS, () => this.dismiss());
  }

  /** Clear the view, stop talking, and stop whatever was going on. An answer still on its way is dropped from view, not from HQ. */
  dismiss(): void {
    this.run++;
    this.stopHearing();
    this.hushNow();
    if (this.timer !== undefined) { this.timers.clear(this.timer); this.timer = undefined; }
    this.phase = "idle"; this.working = false; this.pages = []; this.page = 0; this.cards = undefined;
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
