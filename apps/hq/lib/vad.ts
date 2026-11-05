/**
 * Voice-activity detection from the mic level (RMS of the time-domain signal, 0..1), one value per animation frame.
 *
 * The room's noise floor is the quietest level seen over the last couple of seconds (minimum statistics), so it
 * keeps tracking the room while Phil talks. That matters on laptops: automatic gain control lifts the room noise
 * once speech starts, and a floor frozen at the pre-speech level never lets the turn end.
 *
 * A turn ends after a short stretch below both "a bit above the floor" and "a fraction of how loud he was", or at
 * a hard cap. Something shorter than a word (a cough, a knock) is cancelled instead of sent.
 */
export interface VadOptions {
  minFloor: number;        // never treat the room as quieter than this
  startRatio: number;      // speech starts above floor × this
  endRatio: number;        // speech continues above floor × this …
  endPeakFrac: number;     // … and above this fraction of the loudest moment so far
  endSilenceMs: number;    // this long below both ends the turn
  minSpeechMs: number;     // shorter than this is a cough, not words
  maxUtteranceMs: number;  // a turn never runs longer than this
  floorWindowMs: number;   // the window the floor is the minimum of
}

export const VAD_DEFAULTS: VadOptions = { minFloor: 0.006, startRatio: 2.8, endRatio: 1.8, endPeakFrac: 0.18, endSilenceMs: 800, minSpeechMs: 300, maxUtteranceMs: 15_000, floorWindowMs: 2_000 };

export type VadEvent = "start" | "end" | "cancel" | null;

export class Vad {
  private hist: { t: number; v: number }[] = [];
  floor: number;
  speaking = false;
  private startAt = 0;
  private lastVoice = 0;
  private peak = 0;
  private o: VadOptions;

  constructor(o: Partial<VadOptions> = {}) { this.o = { ...VAD_DEFAULTS, ...o }; this.floor = this.o.minFloor * 2; }

  private level = 0;

  push(raw: number, t: number): VadEvent {
    const o = this.o;
    // Smooth over ~100 ms: raw frames flicker enough that room noise alone would keep crossing the threshold.
    this.level = this.level ? this.level * 0.8 + raw * 0.2 : raw;
    const rms = this.level;
    this.hist.push({ t, v: rms });
    while (this.hist.length && t - this.hist[0]!.t > o.floorWindowMs) this.hist.shift();
    let min = Infinity; for (const h of this.hist) if (h.v < min) min = h.v;
    this.floor = Math.max(o.minFloor, this.floor * 0.9 + min * 0.1);

    if (!this.speaking) {
      if (rms > this.floor * o.startRatio && rms > o.minFloor * 2) { this.speaking = true; this.startAt = t; this.lastVoice = t; this.peak = rms; return "start"; }
      return null;
    }
    this.peak = Math.max(this.peak * 0.999, rms);
    if (rms > Math.max(this.floor * o.endRatio, this.peak * o.endPeakFrac)) this.lastVoice = t;
    if (t - this.startAt > o.maxUtteranceMs) { this.speaking = false; return "end"; }
    if (t - this.lastVoice > o.endSilenceMs) { this.speaking = false; return this.lastVoice - this.startAt < o.minSpeechMs ? "cancel" : "end"; }
    return null;
  }

  /** End the current turn now (Phil pressed "send"). */
  force(): VadEvent { if (!this.speaking) return null; this.speaking = false; return "end"; }
}
