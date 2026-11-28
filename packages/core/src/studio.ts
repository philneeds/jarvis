import { z } from "zod";
import { randomUUID } from "node:crypto";
import { defineTool, type ToolDef } from "./tools/index.js";
import type { Store } from "./store/types.js";
import type { Approval, ChatMessage } from "./events.js";
import type { SecretName, SecretReader, SecretStatus } from "./secrets.js";
import type { Describer, Executor } from "./jarvis/orchestrator.js";
import { loadImage, saveFile, saveImage, MAX_VIDEO_BYTES } from "./uploads.js";

/**
 * Joi's studio: making images and video. A generation is always a card first (action "media.generate"): Joi writes the
 * prompt and picks the model, HQ prices it and puts the price on the card, and nothing is sent or spent until Phil
 * approves. Approving starts the job in the background; the picture or clip arrives in chat (and on Telegram when the
 * request came from there) with what it cost.
 *
 * Each provider is a small object (models, check, start, poll) behind one interface, on when its key is set:
 *   OpenAI (GPT Image), Google (Nano Banana), xAI (Grok Imagine) for images; Higgsfield for video and the image
 *   models it hosts.
 * Keys come from /opt/jarvis/.env or, sealed, from Settings → Studio. They never reach an agent, a card or a log.
 *
 * Spending is held twice: Phil's approval per generation, and caps per item and per day (Eastern) as a backstop.
 * What a provider reports as the real cost is booked; when it reports none, the estimate is.
 */
export type StudioKind = "image" | "video";
export type StudioQuality = "low" | "medium" | "high";
export const STUDIO_ASPECTS = ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4"] as const;
export type StudioAspect = (typeof STUDIO_ASPECTS)[number];

export interface StudioAsk { prompt: string; aspect: StudioAspect; quality: StudioQuality; /** Video only. */ seconds?: number; /** A picture to start from (edit it, or animate it). */ image?: { mime: string; data: Buffer } }
export interface StudioModel {
  /** "openai/gpt-image-2.6-sunburst": what Joi writes on the card. */
  id: string;
  label: string;
  kind: StudioKind;
  /** One line for Joi: what it is good at. */
  note: string;
  /** "optional": can start from a picture; "required": must (image-to-video); "no": text only. */
  image: "no" | "optional" | "required";
  /** Lengths a video model takes, in seconds; the first is the default. */
  seconds?: number[];
  /** What this ask is expected to cost, in dollars; undefined when HQ has no price for it (then it isn't sent). */
  estimate(ask: Pick<StudioAsk, "quality" | "seconds" | "aspect"> & { image?: unknown }): number | undefined;
}
export interface StudioOutput { data: Buffer; mime: string }
export interface StudioResult { outputs: StudioOutput[]; /** What the provider says it cost, when it says. */ costUsd?: number }
/** A job the provider runs on its side: `remote` is what poll() needs to find it again, after a restart too. */
export type StudioStarted = { result: StudioResult } | { remote: string };
export type StudioPolled = { done: false } | { done: true; result: StudioResult };

export interface StudioProviderOptions { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; secrets?: SecretReader; timeoutMs?: number }
export interface StudioProvider {
  readonly id: string;
  readonly label: string;
  /** The keys it needs, in the order Settings asks for them. */
  readonly keys: { name: SecretName; label: string }[];
  /** Where Phil gets the key, for Settings. */
  readonly keyHelp: string;
  models(): StudioModel[];
  /** One cheap call that proves the key; a line for Settings or a throw in the provider's words. */
  check(): Promise<string>;
  /** The provider's own price for this ask, when it has an endpoint for that; it goes on the card instead of HQ's table. */
  quote?(model: StudioModel, ask: Omit<StudioAsk, "image"> & { image?: boolean }): Promise<number>;
  start(model: StudioModel, ask: StudioAsk): Promise<StudioStarted>;
  poll?(remote: string): Promise<StudioPolled>;
}

/** Thrown when the request may have been taken (a timeout mid-generation), so the spend is booked anyway. */
export class StudioSentError extends Error {}
/** Thrown when the provider itself ended the job without making anything (failed, blocked, cancelled) and doesn't charge for it. */
export class StudioRefusedError extends Error {}

// ---- Shared plumbing for the providers ----------------------------------------------------------------------------

export class ProviderBase {
  constructor(protected o: StudioProviderOptions = {}) {}
  protected get env() { return this.o.env ?? process.env; }
  /** .env first (the server's own secret wins), else what Phil saved in Settings. */
  protected secret(name: SecretName) { return (this.env[name] ?? "").trim() || (this.o.secrets?.get(name) ?? "").trim(); }
  protected clean(s: string, names: SecretName[]) { let out = s; for (const n of names) { const k = this.secret(n); if (k) out = out.split(k).join("[key]"); } return out; }

  /** One JSON call. Keys travel in headers and are cut out of any error text; a non-2xx is a throw in plain words. */
  protected async json<T>(who: string, url: string, init: { method?: string; headers: Record<string, string>; body?: unknown; timeoutMs?: number; sent?: boolean; keys: SecretName[] }): Promise<T> {
    const ms = init.timeoutMs ?? this.o.timeoutMs ?? 60_000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, { method: init.method ?? "POST", headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), signal: ctl.signal });
    } catch (e) {
      const msg = ctl.signal.aborted ? `${who} took longer than ${Math.round(ms / 1000)}s` : `${who} couldn't be reached (${this.clean((e as Error).message, init.keys)})`;
      throw init.sent ? new StudioSentError(msg) : new Error(msg);
    } finally { clearTimeout(timer); }
    const raw = await res.text().catch(() => "");
    if (res.ok) { try { return JSON.parse(raw) as T; } catch { throw new (init.sent ? StudioSentError : Error)(`${who} answered with something that isn't JSON`); } }
    let message = raw;
    try { const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string; detail?: unknown }; message = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.message ?? (typeof j.detail === "string" ? j.detail : raw); } catch { /* not JSON: the text is the message */ }
    message = this.clean(String(message), init.keys).replace(/\s+/g, " ").slice(0, 240);
    if (res.status === 401 || (res.status === 403 && /key|credential|unauthor/i.test(message))) throw new Error(`${who} refused the key (${message || res.status})`);
    if (res.status === 429) throw new Error(`${who}'s rate limit or credit is used up for now (${message || "429"})`);
    if (res.status === 402) throw new Error(`${who} says the account is out of credit (${message || "402"})`);
    throw new Error(`${who} ${res.status}: ${message || "no reason given"}`);
  }

  /** Fetch a finished file from the provider's own storage: https only, a size limit, never with HQ's keys. */
  protected async download(who: string, url: string, kind: StudioKind): Promise<StudioOutput> {
    let u: URL;
    try { u = new URL(url); } catch { throw new StudioSentError(`${who} returned a link HQ can't read`); }
    if (u.protocol !== "https:") throw new StudioSentError(`${who} returned a link that isn't https, so HQ didn't fetch it`);
    const max = kind === "video" ? MAX_VIDEO_BYTES : 30 * 1024 * 1024;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 180_000);
    try {
      const res = await (this.o.fetch ?? fetch)(u.toString(), { signal: ctl.signal });
      if (!res.ok) throw new StudioSentError(`${who} made the ${kind} but its file couldn't be fetched (${res.status})`);
      const data = Buffer.from(await res.arrayBuffer());
      if (!data.length) throw new StudioSentError(`${who} made the ${kind} but the file was empty`);
      if (data.length > max) throw new StudioSentError(`${who} made a ${kind} of ${Math.round(data.length / 1048576)} MB, more than HQ keeps (${Math.round(max / 1048576)} MB)`);
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      return { data, mime: sniff(data) ?? (type || (kind === "video" ? "video/mp4" : "image/png")) };
    } catch (e) {
      if (e instanceof StudioSentError) throw e;
      throw new StudioSentError(`${who} made the ${kind} but its file couldn't be fetched (${ctl.signal.aborted ? "timed out" : (e as Error).message.slice(0, 120)})`);
    } finally { clearTimeout(timer); }
  }
}

/** The file type from its first bytes: what a provider calls a file isn't always what it is. */
export function sniff(b: Buffer): string | undefined {
  if (b.length < 12) return undefined;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return undefined;
}
const dataUrl = (i: { mime: string; data: Buffer }) => `data:${i.mime};base64,${i.data.toString("base64")}`;
const fromB64 = (who: string, b64: unknown): StudioOutput => {
  if (typeof b64 !== "string" || b64.length < 100) throw new StudioSentError(`${who} returned no image`);
  const data = Buffer.from(b64, "base64");
  return { data, mime: sniff(data) ?? "image/png" };
};

// ---- OpenAI: GPT Image --------------------------------------------------------------------------------------------

/** Per image at 1024x1024 / the wide and tall sizes (developers.openai.com image guide's GPT Image 2 table, read 2026-11-28). The response's token usage gives the real figure, which is what's booked. */
const OPENAI_EST: Record<StudioQuality, [number, number]> = { low: [0.006, 0.005], medium: [0.053, 0.041], high: [0.211, 0.165] };
/** Dollars per million tokens (developers.openai.com/api/docs/pricing, read 2026-11-28). */
const OPENAI_RATE = { textIn: 5, imageIn: 8, imageOut: 30 };
const OPENAI_SIZE: Record<StudioAspect, string> = { "1:1": "1024x1024", "16:9": "1536x1024", "3:2": "1536x1024", "4:3": "1536x1024", "9:16": "1024x1536", "2:3": "1024x1536", "3:4": "1024x1536" };

export class OpenAIStudio extends ProviderBase implements StudioProvider {
  readonly id = "openai";
  readonly label = "OpenAI";
  readonly keys = [{ name: "OPENAI_API_KEY" as const, label: "OpenAI API key" }];
  readonly keyHelp = "platform.openai.com → API keys. GPT Image models may need the organisation verified first (Settings → Organization → General).";
  private auth() { return { authorization: `Bearer ${this.secret("OPENAI_API_KEY")}` }; }
  models(): StudioModel[] {
    const est: StudioModel["estimate"] = (a) => { const [sq, other] = OPENAI_EST[a.quality]; return (a.aspect === "1:1" ? sq : other) + (a.image ? 0.01 : 0); };
    return [
      { id: "openai/gpt-image-2.6-sunburst", label: "GPT Image 2.6 Sunburst", kind: "image", image: "optional", note: "OpenAI's detailed model: the best at text inside an image, layouts, logos, infographics and following a long brief exactly; edits a photo while keeping what's in it.", estimate: est },
      { id: "openai/gpt-image-2.6-flare", label: "GPT Image 2.6 Flare", kind: "image", image: "optional", note: "OpenAI's fast model: quick drafts and variations before a final on Sunburst.", estimate: est },
    ];
  }
  async check() {
    const j = await this.json<{ id?: string }>("OpenAI", "https://api.openai.com/v1/models/gpt-image-2.6-sunburst", { method: "GET", headers: this.auth(), keys: ["OPENAI_API_KEY"], timeoutMs: 20_000 });
    return `OpenAI accepted the key and offers ${j.id ?? "GPT Image"}.`;
  }
  async start(model: StudioModel, ask: StudioAsk): Promise<StudioStarted> {
    const common = { model: model.id.split("/")[1], prompt: ask.prompt, size: OPENAI_SIZE[ask.aspect], quality: ask.quality, n: 1, output_format: "png" };
    type Out = { data?: { b64_json?: string }[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { image_tokens?: number; text_tokens?: number } } };
    const j = await this.json<Out>("OpenAI", `https://api.openai.com/v1/images/${ask.image ? "edits" : "generations"}`, {
      headers: this.auth(), keys: ["OPENAI_API_KEY"], sent: true, timeoutMs: this.o.timeoutMs ?? 300_000,
      body: ask.image ? { ...common, images: [{ image_url: dataUrl(ask.image) }] } : common,
    });
    const u = j.usage;
    const imgIn = u?.input_tokens_details?.image_tokens ?? 0;
    const costUsd = u?.output_tokens ? ((u.output_tokens * OPENAI_RATE.imageOut) + (imgIn * OPENAI_RATE.imageIn) + (((u.input_tokens ?? 0) - imgIn) * OPENAI_RATE.textIn)) / 1e6 : undefined;
    return { result: { outputs: [fromB64("OpenAI", j.data?.[0]?.b64_json)], costUsd } };
  }
}

// ---- Google: Nano Banana (Gemini image models, generateContent) ---------------------------------------------------

const GOOGLE_HOST = "https://generativelanguage.googleapis.com";
const GOOGLE_SIZE: Record<StudioQuality, "1K" | "2K" | "4K"> = { low: "1K", medium: "2K", high: "4K" };
/** Per image by size (aistudio.google.com/docs/pricing, standard paid tier, read 2026-11-28). */
const GOOGLE_PRICE: Record<string, Record<"1K" | "2K" | "4K", number>> = {
  "gemini-3-pro-image": { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
  "gemini-3.1-flash-image": { "1K": 0.067, "2K": 0.101, "4K": 0.151 },
};

export class GoogleStudio extends ProviderBase implements StudioProvider {
  readonly id = "google";
  readonly label = "Google";
  readonly keys = [{ name: "GEMINI_API_KEY" as const, label: "Gemini API key" }];
  readonly keyHelp = "aistudio.google.com/apikey, on a Google Cloud project with billing on. The same key the video reader uses.";
  private auth() { return { "x-goog-api-key": this.secret("GEMINI_API_KEY") }; }
  models(): StudioModel[] {
    const est = (m: string): StudioModel["estimate"] => (a) => GOOGLE_PRICE[m]![GOOGLE_SIZE[a.quality]] + (a.image ? 0.002 : 0);
    return [
      { id: "google/gemini-3-pro-image", label: "Nano Banana Pro", kind: "image", image: "optional", note: "Google's best: photoreal people and products, keeps a face or product the same across edits, accurate text; quality high is 4K.", estimate: est("gemini-3-pro-image") },
      { id: "google/gemini-3.1-flash-image", label: "Nano Banana 2", kind: "image", image: "optional", note: "Google's fast one at about half the price: everyday images and quick photo edits.", estimate: est("gemini-3.1-flash-image") },
    ];
  }
  async check() {
    const j = await this.json<{ displayName?: string }>("Google", `${GOOGLE_HOST}/v1beta/models/gemini-3-pro-image`, { method: "GET", headers: this.auth(), keys: ["GEMINI_API_KEY"], timeoutMs: 20_000 });
    return `Google accepted the key and offers ${j.displayName ?? "Nano Banana Pro"}.`;
  }
  async start(model: StudioModel, ask: StudioAsk): Promise<StudioStarted> {
    const m = model.id.split("/")[1]!;
    type Out = { candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
    const j = await this.json<Out>("Google", `${GOOGLE_HOST}/v1beta/models/${m}:generateContent`, {
      headers: this.auth(), keys: ["GEMINI_API_KEY"], sent: true, timeoutMs: this.o.timeoutMs ?? 300_000,
      body: {
        contents: [{ role: "user", parts: [...(ask.image ? [{ inlineData: { mimeType: ask.image.mime, data: ask.image.data.toString("base64") } }] : []), { text: ask.prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: ask.aspect, imageSize: GOOGLE_SIZE[ask.quality] } },
      },
    });
    const c = j.candidates?.[0];
    const part = c?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) {
      const said = c?.content?.parts?.map((p) => p.text ?? "").join(" ").trim().slice(0, 160);
      throw new StudioSentError(`Google made no image: ${j.promptFeedback?.blockReason ? `the prompt was blocked (${j.promptFeedback.blockReason})` : c?.finishReason && c.finishReason !== "STOP" ? `it stopped (${c.finishReason})` : said || "it returned nothing"}`);
    }
    return { result: { outputs: [fromB64("Google", part.inlineData!.data)] } };
  }
}

// ---- xAI: Grok Imagine --------------------------------------------------------------------------------------------

const XAI_RES: Record<StudioQuality, string> = { low: "1k", medium: "1.5k", high: "2k" };

export class XaiStudio extends ProviderBase implements StudioProvider {
  readonly id = "xai";
  readonly label = "xAI";
  readonly keys = [{ name: "XAI_API_KEY" as const, label: "xAI API key" }];
  readonly keyHelp = "console.x.ai → API keys. The same key HQ's X search uses.";
  private auth() { return { authorization: `Bearer ${this.secret("XAI_API_KEY")}` }; }
  models(): StudioModel[] {
    // Flat per image (docs.x.ai/developers/pricing, read 2026-11-28); the response's own cost figure is what's booked.
    return [{ id: "xai/grok-imagine-image-2.0", label: "Grok Imagine 2.0", kind: "image", image: "optional", note: "xAI's image model: punchy, stylised, meme and poster looks, looser about what it will draw; cheap, so good for trying ideas.", estimate: (a) => 0.04 + (a.image ? 0.01 : 0) }];
  }
  async check() {
    const j = await this.json<{ id?: string }>("xAI", "https://api.x.ai/v1/models/grok-imagine-image-2.0", { method: "GET", headers: this.auth(), keys: ["XAI_API_KEY"], timeoutMs: 20_000 }).catch(async (e: Error) => {
      // The model card isn't on every key's list; the plain list still proves the key.
      if (/refused the key/.test(e.message)) throw e;
      await this.json("xAI", "https://api.x.ai/v1/models", { method: "GET", headers: this.auth(), keys: ["XAI_API_KEY"], timeoutMs: 20_000 });
      return { id: undefined };
    });
    return `xAI accepted the key${j.id ? ` and offers ${j.id}` : ""}.`;
  }
  async start(model: StudioModel, ask: StudioAsk): Promise<StudioStarted> {
    const common = { model: model.id.split("/")[1], prompt: ask.prompt, n: 1, response_format: "b64_json", aspect_ratio: ask.aspect, resolution: XAI_RES[ask.quality] };
    type Out = { data?: { b64_json?: string }[]; usage?: { cost_in_usd_ticks?: number } };
    const j = await this.json<Out>("xAI", `https://api.x.ai/v1/images/${ask.image ? "edits" : "generations"}`, {
      headers: this.auth(), keys: ["XAI_API_KEY"], sent: true, timeoutMs: this.o.timeoutMs ?? 300_000,
      body: ask.image ? { ...common, image: { url: dataUrl(ask.image), type: "image_url" } } : common,
    });
    // $1 is 10,000,000,000 ticks.
    const ticks = j.usage?.cost_in_usd_ticks;
    return { result: { outputs: [fromB64("xAI", j.data?.[0]?.b64_json)], costUsd: typeof ticks === "number" && ticks > 0 ? ticks / 1e10 : undefined } };
  }
}

// ---- Higgsfield: video, and the image models it hosts -------------------------------------------------------------

const HF_HOST = "https://api.higgsfield.ai";
type HfBuild = (ask: Omit<StudioAsk, "image">, imageUrl?: string) => { path: string; body: Record<string, unknown> };
const pick = <T extends string>(aspect: StudioAspect, map: Partial<Record<StudioAspect, T>>, fallback: T): T => map[aspect] ?? fallback;
const HF_RES: Record<StudioQuality, string> = { low: "480p", medium: "720p", high: "1080p" };
/**
 * The Higgsfield models Joi gets, each mapped onto its documented endpoints (docs.higgsfield.ai, read 2026-11-28): the
 * text-to-video one, or the image-to-video one when the card starts from a picture. Higgsfield prices each request
 * itself (POST /estimate/<model>), so these carry no price table: the card shows Higgsfield's own figure.
 */
const HF_MODELS: { model: Omit<StudioModel, "estimate">; build: HfBuild }[] = [
  {
    model: { id: "higgsfield/kling-3.0", label: "Kling 3.0 Pro", kind: "video", image: "optional", seconds: [5, 10, 15], note: "The all-rounder for a finished clip: strong motion and physics, people who stay the same person, sound included. Roughly $0.10 to $0.15 a second. Text-to-video is 16:9, 9:16 or 1:1; from a picture it keeps the picture's shape." },
    build: (a, img) => img
      ? { path: "kling-video/v3.0/pro/image-to-video", body: { prompt: a.prompt, duration: a.seconds, image_url: img, sound: "on" } }
      : { path: "kling-video/v3.0/pro/text-to-video", body: { prompt: a.prompt, duration: a.seconds, aspect_ratio: pick(a.aspect, { "1:1": "1:1", "9:16": "9:16", "2:3": "9:16", "3:4": "9:16" }, "16:9"), sound: "on" } },
  },
  {
    model: { id: "higgsfield/seedance-2.0", label: "Seedance 2.0", kind: "video", image: "optional", seconds: [5, 10, 15], note: "Cinematic camera moves and multi-shot scenes with sound; quality picks 480p, 720p or 1080p, and the price climbs steeply with it (about $0.08 a second at 480p)." },
    build: (a, img) => img
      ? { path: "bytedance/seedance-2.0/image-to-video", body: { prompt: a.prompt, duration: a.seconds, image_url: img, resolution: HF_RES[a.quality], generate_audio: true } }
      : { path: "bytedance/seedance-2.0/text-to-video", body: { prompt: a.prompt, duration: a.seconds, resolution: HF_RES[a.quality], aspect_ratio: pick(a.aspect, { "1:1": "1:1", "9:16": "9:16", "4:3": "4:3", "3:2": "4:3", "3:4": "3:4", "2:3": "3:4" }, "16:9"), generate_audio: true } },
  },
  {
    model: { id: "higgsfield/wan-3.0", label: "Wan 3.0", kind: "video", image: "optional", seconds: [5, 10, 15], note: "The cheap one with sound (from about $0.04 a second at low quality): test a shot or a motion idea here before paying for Kling or Seedance." },
    build: (a, img) => {
      const base = { prompt: a.prompt, duration: a.seconds, resolution: HF_RES[a.quality], generate_audio: true };
      return img
        ? { path: "alibaba/wan-3.0/image-to-video", body: { ...base, image_url: img, aspect_ratio: "adaptive" } }
        : { path: "alibaba/wan-3.0/text-to-video", body: { ...base, aspect_ratio: pick(a.aspect, { "1:1": "1:1", "9:16": "9:16", "4:3": "4:3", "3:2": "4:3", "3:4": "3:4", "2:3": "3:4" }, "16:9") } };
    },
  },
  {
    model: { id: "higgsfield/kling-2.5-turbo", label: "Kling 2.5 Turbo Pro", kind: "video", image: "optional", seconds: [5, 10], note: "Fast and about $0.05 a second, no sound: quick drafts and simple motion from a picture. It picks the shape itself (the picture's, when there is one)." },
    build: (a, img) => img
      ? { path: "kling-video/v2.5-turbo/pro/image-to-video", body: { prompt: a.prompt, duration: a.seconds, image_url: img } }
      : { path: "kling-video/v2.5-turbo/pro/text-to-video", body: { prompt: a.prompt, duration: a.seconds } },
  },
  {
    model: { id: "higgsfield/soul-v2", label: "Higgsfield Soul V2", kind: "image", image: "no", note: "Higgsfield's own image model: fashion and lifestyle photos of people that look shot on a real camera. Good as the start frame for a video." },
    build: (a) => ({ path: "higgsfield-ai/soul/v2/standard", body: { prompt: a.prompt, aspect_ratio: a.aspect, resolution: a.quality === "high" ? "1080p" : "720p", enhance_prompt: false, batch_size: 1 } }),
  },
];

export class HiggsfieldStudio extends ProviderBase implements StudioProvider {
  readonly id = "higgsfield";
  readonly label = "Higgsfield";
  readonly keys = [{ name: "HIGGSFIELD_API_KEY" as const, label: "Higgsfield key, as KEY_ID:KEY_SECRET" }];
  readonly keyHelp = "open.higgsfield.ai/api-keys: make an API key, then paste its id and secret joined by a colon (KEY_ID:KEY_SECRET). It draws on a prepaid balance you top up there.";
  private auth() { return { authorization: `Key ${this.secret("HIGGSFIELD_API_KEY")}` }; }
  private call<T>(url: string, init: { method?: string; body?: unknown; sent?: boolean; timeoutMs?: number; headers?: Record<string, string> }) {
    return this.json<T>("Higgsfield", url, { ...init, headers: { ...this.auth(), ...init.headers }, keys: ["HIGGSFIELD_API_KEY"] });
  }
  models(): StudioModel[] { return HF_MODELS.map((m) => ({ ...m.model, estimate: () => undefined })); }
  private entry(model: StudioModel) { const e = HF_MODELS.find((m) => m.model.id === model.id); if (!e) throw new Error(`Higgsfield has no model ${model.id}`); return e; }

  private async estimate(path: string, body: Record<string, unknown>): Promise<number> {
    const j = await this.call<{ usd?: string | number }>(`${HF_HOST}/estimate/${path}`, { body, timeoutMs: 30_000 });
    const n = Number(j.usd);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Higgsfield returned no price");
    return n;
  }
  async check() {
    if (!/^[^:\s]+:[^:\s]+$/.test(this.secret("HIGGSFIELD_API_KEY"))) throw new Error("the Higgsfield key must be the key id and the key secret joined by a colon (KEY_ID:KEY_SECRET)");
    const { path, body } = HF_MODELS.find((m) => m.model.kind === "image")!.build({ prompt: "A quiet alpine lake at sunrise", aspect: "1:1", quality: "low" });
    return `Higgsfield accepted the key (it quotes $${(await this.estimate(path, body)).toFixed(3)} for a Soul image). Video is on.`;
  }
  /** Higgsfield's own price for the request. A card that starts from a picture is priced before the picture is uploaded. */
  async quote(model: StudioModel, ask: Omit<StudioAsk, "image"> & { image?: boolean }): Promise<number> {
    const e = this.entry(model);
    if (ask.image) {
      const withImage = e.build(ask, "https://example.com/input.jpg");
      try { return await this.estimate(withImage.path, withImage.body); }
      catch (err) { if (/refused the key/.test((err as Error).message)) throw err; /* priced as the text version instead */ }
    }
    const text = e.build(ask);
    return this.estimate(text.path, text.body);
  }

  /** Put the start picture where Higgsfield can read it: its own temporary upload store. */
  private async upload(image: { mime: string; data: Buffer }): Promise<string> {
    const mime = image.mime === "image/jpg" ? "image/jpeg" : image.mime;
    const u = await this.call<{ public_url?: string; upload_url?: string; upload_headers?: Record<string, string> }>(`${HF_HOST}/files/generate-upload-url`, { body: { content_type: mime }, timeoutMs: 30_000 });
    if (!u.upload_url?.startsWith("https://") || !u.public_url?.startsWith("https://")) throw new Error("Higgsfield gave no address to upload the picture to");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120_000);
    try {
      // Straight to its storage with the headers it asked for, and without HQ's key.
      const res = await (this.o.fetch ?? fetch)(u.upload_url, { method: "PUT", headers: { "content-type": mime, ...(u.upload_headers ?? {}) }, body: new Uint8Array(image.data), signal: ctl.signal });
      if (!res.ok) throw new Error(`Higgsfield's storage refused the picture (${res.status})`);
    } catch (e) { throw new Error(ctl.signal.aborted ? "uploading the picture to Higgsfield timed out" : (e as Error).message); } finally { clearTimeout(timer); }
    return u.public_url;
  }

  async start(model: StudioModel, ask: StudioAsk): Promise<StudioStarted> {
    const e = this.entry(model);
    const imageUrl = ask.image ? await this.upload(ask.image) : undefined;
    const { path, body } = e.build(ask, imageUrl);
    const j = await this.call<{ request_id?: string }>(`${HF_HOST}/${path}`, { body, sent: true, timeoutMs: 60_000, headers: { "idempotency-key": randomUUID() } });
    if (!j.request_id || !/^[A-Za-z0-9-]{8,64}$/.test(j.request_id)) throw new StudioSentError("Higgsfield took the request but returned no id to follow it by");
    return { remote: `${model.kind}:${j.request_id}` };
  }

  async poll(remote: string): Promise<StudioPolled> {
    const [kind, id] = remote.split(":") as [StudioKind, string];
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id ?? "")) throw new StudioRefusedError("HQ lost track of the Higgsfield request");
    type Status = { status?: string; error?: unknown; images?: { url?: string }[]; video?: { url?: string } };
    const j = await this.call<Status>(`${HF_HOST}/requests/${id}/status`, { method: "GET", timeoutMs: 30_000 });
    if (j.status === "queued" || j.status === "in_progress") return { done: false };
    // Higgsfield doesn't charge for a request that failed, was blocked or was cancelled.
    if (j.status === "failed") throw new StudioRefusedError(`Higgsfield couldn't make it${typeof j.error === "string" && j.error ? ` (${j.error.replace(/\s+/g, " ").slice(0, 200)})` : ""}`);
    if (j.status === "nsfw") throw new StudioRefusedError("Higgsfield's content filter blocked it; reword the prompt");
    if (j.status === "canceled") throw new StudioRefusedError("the Higgsfield request was cancelled");
    if (j.status !== "completed") throw new Error(`Higgsfield reported a status HQ doesn't know (${String(j.status).slice(0, 40)})`);
    const urls = kind === "video" ? [j.video?.url] : (j.images ?? []).map((i) => i.url);
    const good = urls.filter((x): x is string => typeof x === "string" && !!x);
    if (!good.length) throw new StudioSentError(`Higgsfield finished but returned no ${kind}`);
    return { done: true, result: { outputs: await Promise.all(good.slice(0, 4).map((x) => this.download("Higgsfield", x, kind))) } };
  }
}

/** The providers HQ knows. A new one is added here. */
export const STUDIO_PROVIDERS: ((o: StudioProviderOptions) => StudioProvider)[] = [(o) => new OpenAIStudio(o), (o) => new GoogleStudio(o), (o) => new XaiStudio(o), (o) => new HiggsfieldStudio(o)];

// ---- Caps, spend and the job list ---------------------------------------------------------------------------------

const positive = (v: string | undefined) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? n : undefined; };
/** A backstop behind Phil's approval of each card: what one generation and one day may cost, in dollars. */
export function studioCaps(env: NodeJS.ProcessEnv = process.env) {
  return { perItemUsd: positive(env.STUDIO_CAP_PER_ITEM_USD) ?? 5, perDayUsd: positive(env.STUDIO_CAP_PER_DAY_USD) ?? 25 };
}
export const STUDIO_SPEND_KEY = "studio.spend";
export const STUDIO_JOBS_KEY = "studio.jobs";
export const STUDIO_ACTION = "media.generate";
export interface StudioSpend { day: string; usd: number; items: number }
export interface StudioJob {
  id: string; at: string; agentId: string; model: string; kind: StudioKind; prompt: string; title: string;
  aspect: StudioAspect; quality: StudioQuality; seconds?: number; image?: string;
  estimateUsd: number; status: "running" | "done" | "failed";
  /** The provider's handle on a job it runs on its side, so a restart can pick it up. */
  remote?: string;
  channel?: ChatMessage["channel"];
  /** Upload ids of what was made: an image id (shown in chat) or a video file id. */
  outputs?: string[];
  costUsd?: number; error?: string; doneAt?: string;
}
const PHIL_TZ = process.env.PHIL_TZ || "America/New_York";
const dayOf = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: PHIL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
const KEEP_JOBS = 60;

export interface StudioStatus {
  providers: { id: string; label: string; configured: boolean; keyHelp: string; keys: (SecretStatus & { name: SecretName; label: string; canSave: boolean })[]; models: { id: string; label: string; kind: StudioKind; from: number | undefined }[] }[];
  spend: StudioSpend; caps: ReturnType<typeof studioCaps>;
}

export interface StudioDeps {
  store: Store;
  secrets?: SecretReader;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  providers?: StudioProvider[];
  /** The conversation a card is being written in: where the result should go, and the pictures Phil attached. */
  conversation?: () => { channel?: ChatMessage["channel"]; images?: string[] } | undefined;
  /** Put the finished work in chat. */
  deliver?: (m: Omit<ChatMessage, "id" | "at">) => Promise<unknown>;
  log?: (agentId: string, kind: "system" | "error", summary: string) => Promise<unknown>;
  /** Between checks on a job the provider is running (tests shorten it). */
  pollMs?: number;
  /** How long a provider-side job may take before HQ stops waiting. */
  jobTimeoutMs?: number;
  /** Which agents get the studio; Joi unless STUDIO_AGENTS says otherwise. */
  agents?: string[];
}

interface Parsed { model: StudioModel; provider: StudioProvider; ask: Omit<StudioAsk, "image">; image?: string; title: string; estimateUsd: number }

export class Studio {
  readonly id = "studio";
  readonly providers: StudioProvider[];
  private queue: Promise<unknown> = Promise.resolve();
  /** Jobs this process is working on (the rest of the "running" ones were left by a restart). */
  private live = new Set<string>();
  /** Money promised to jobs that haven't finished, so two approvals in a row can't both slip under the daily cap. */
  private held = 0;
  constructor(private deps: StudioDeps) {
    const env = deps.env ?? process.env;
    this.providers = deps.providers ?? STUDIO_PROVIDERS.map((make) => make({ fetch: deps.fetch, env, secrets: deps.secrets }));
  }
  private get env() { return this.deps.env ?? process.env; }
  private now() { return new Date((this.deps.now ?? Date.now)()); }
  private one<T>(job: () => Promise<T>): Promise<T> { const p = this.queue.then(job, job); this.queue = p.catch(() => undefined); return p; }
  private agents() { return this.deps.agents ?? ((this.env.STUDIO_AGENTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).length ? (this.env.STUDIO_AGENTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : ["joi"]); }

  private keyState(p: StudioProvider, name: SecretName): SecretStatus {
    if ((this.env[name] ?? "").trim()) return { set: true, source: "env" };
    return this.deps.secrets?.status(name) ?? { set: false, source: "none" };
  }
  configured(p: StudioProvider) { return p.keys.every((k) => this.keyState(p, k.name).set); }
  provider(id: string) { return this.providers.find((p) => p.id === id); }
  /** Every model of every provider with a key. */
  models(): { model: StudioModel; provider: StudioProvider }[] { return this.providers.filter((p) => this.configured(p)).flatMap((p) => p.models().map((model) => ({ model, provider: p }))); }
  private find(id: string) { for (const p of this.providers) { const model = p.models().find((m) => m.id === id); if (model) return { model, provider: p }; } return undefined; }

  async spentToday(): Promise<StudioSpend> {
    const day = dayOf(this.now());
    const s = await this.deps.store.settings.get<StudioSpend | null>(STUDIO_SPEND_KEY, null);
    return s && s.day === day && Number.isFinite(s.usd) ? s : { day, usd: 0, items: 0 };
  }
  private book(usdSpent: number) {
    return this.one(async () => { const s = await this.spentToday(); await this.deps.store.settings.set(STUDIO_SPEND_KEY, { day: s.day, usd: Math.round((s.usd + usdSpent) * 1e6) / 1e6, items: s.items + 1 }); });
  }
  async jobs(): Promise<StudioJob[]> { return this.deps.store.settings.get<StudioJob[]>(STUDIO_JOBS_KEY, []); }
  private saveJob(job: StudioJob) {
    return this.one(async () => { const all = (await this.jobs()).filter((j) => j.id !== job.id); await this.deps.store.settings.set(STUDIO_JOBS_KEY, [job, ...all].slice(0, KEEP_JOBS)); });
  }

  /** For Settings: each provider, whether its key is in, its models and where they start in price. Never a key. */
  async status(): Promise<StudioStatus> {
    return {
      providers: this.providers.map((p) => ({
        id: p.id, label: p.label, configured: this.configured(p), keyHelp: p.keyHelp,
        keys: p.keys.map((k) => ({ ...k, ...this.keyState(p, k.name), canSave: this.deps.secrets?.canSave() ?? false })),
        models: p.models().map((m) => ({ id: m.id, label: m.label, kind: m.kind, from: m.estimate({ quality: "low", aspect: "1:1", seconds: m.seconds?.[0] }) })),
      })),
      spend: await this.spentToday(), caps: studioCaps(this.env),
    };
  }
  async check(providerId: string): Promise<string> {
    const p = this.provider(providerId);
    if (!p) throw new Error(`HQ has no studio provider called ${providerId}`);
    if (!this.configured(p)) throw new Error(`${p.label} has no key yet`);
    return p.check();
  }

  // ---- The card: read, fill in, refuse early ------------------------------------------------------------------------

  /** Read a media.generate payload: a problem in words for the agent, or everything needed to run it. */
  private parse(p: Record<string, unknown>): Parsed | string {
    const id = typeof p.model === "string" ? p.model.trim() : "";
    const hit = id ? this.find(id) : undefined;
    const on = this.models().map((m) => m.model.id);
    if (!hit) return `"model" must be one of the studio's model ids${on.length ? ` (${on.join(", ")})` : " (none is connected yet: Phil adds a key under Settings → Studio)"}; studio_models lists them`;
    const { model, provider } = hit;
    if (!this.configured(provider)) return `${provider.label} isn't connected: Phil pastes its key under Settings → Studio. ${on.length ? `Connected now: ${on.join(", ")}` : "No studio provider is connected yet"}`;
    const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
    if (prompt.length < 3) return `"prompt" is missing: the exact words for the model`;
    if (prompt.length > 4000) return `"prompt" is over 4,000 characters`;
    const aspect = (typeof p.aspect === "string" ? p.aspect.trim() : "") || (model.kind === "video" ? "16:9" : "1:1");
    if (!(STUDIO_ASPECTS as readonly string[]).includes(aspect)) return `"aspect" must be one of ${STUDIO_ASPECTS.join(", ")}`;
    const quality = (typeof p.quality === "string" ? p.quality.trim().toLowerCase() : "") || "medium";
    if (!["low", "medium", "high"].includes(quality)) return `"quality" must be low, medium or high`;
    let seconds: number | undefined;
    if (model.kind === "video") {
      const allowed = model.seconds ?? [5];
      seconds = p.seconds === undefined ? allowed[0]! : Number(p.seconds);
      if (!allowed.includes(seconds)) return `"seconds" for ${model.label} must be ${allowed.join(" or ")}`;
    }
    const image = typeof p.image === "string" && p.image.trim() ? p.image.trim() : undefined;
    if (image && model.image === "no") return `${model.label} can't start from a picture; leave "image" out or pick a model that takes one`;
    if (!image && model.image === "required") return `${model.label} animates a picture, so it needs "image": the id of one Phil attached ("attached") or one the studio made (studio_recent lists them)`;
    if (image && /^(attached|the attached (image|picture|photo))$/i.test(image)) return `no picture is attached to Phil's message, so there is nothing to start from; ask him to send it`;
    if (image && !/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(image)) return `"image" must be "attached" (the picture Phil sent with his message) or the id of a stored picture such as one from studio_recent; a link can't be used`;
    const ask = { prompt, aspect: aspect as StudioAspect, quality: quality as StudioQuality, seconds };
    // HQ's own figure from the provider (normalize put it there; an agent's number is never taken), else HQ's table.
    const quoted = typeof p.quoteUsd === "number" && Number.isFinite(p.quoteUsd) && p.quoteUsd > 0 ? p.quoteUsd : undefined;
    const estimateUsd = quoted ?? model.estimate({ ...ask, image });
    if (estimateUsd === undefined) return typeof p.quoteProblem === "string" ? `${provider.label} couldn't price it, so HQ can't put a cost on the card (${p.quoteProblem})` : `HQ has no price for ${model.label} with those settings, so it can't put a cost on the card`;
    const title = (typeof p.title === "string" && p.title.trim() ? p.title.trim() : prompt).replace(/\s+/g, " ").slice(0, 80);
    return { model, provider, ask, image, title, estimateUsd };
  }

  /** Before Phil sees the card: "attached" becomes the picture he sent, and the conversation it came from is kept. */
  async normalize(payload: Record<string, unknown>): Promise<Record<string, unknown> | void> {
    if (payload.action !== STUDIO_ACTION) return;
    const convo = this.deps.conversation?.();
    const out = { ...payload };
    if (typeof out.image === "string" && /^(attached|the attached (image|picture|photo))$/i.test(out.image.trim())) { const first = convo?.images?.[0]; if (first) out.image = first; }
    if (convo?.channel && !out.channel) out.channel = convo.channel;
    await this.price(out);
    return out;
  }

  /** Ask the provider what this would cost, where it can say; whatever number the agent wrote is thrown away. */
  private async price(p: Record<string, unknown>): Promise<void> {
    delete p.quoteUsd; delete p.quoteProblem;
    const r = this.parse(p);
    const hit = typeof p.model === "string" ? this.find(p.model.trim()) : undefined;
    if (!hit?.provider.quote || !this.configured(hit.provider)) return;
    // Parsed without a price, the only complaint left is the missing price: anything else goes back to the agent as it is.
    if (typeof r === "string" && !/can't put a cost on the card/.test(r)) return;
    const prompt = String(p.prompt ?? "").trim(), aspect = (String(p.aspect ?? "").trim() || (hit.model.kind === "video" ? "16:9" : "1:1")) as StudioAspect;
    const quality = (String(p.quality ?? "").trim().toLowerCase() || "medium") as StudioQuality;
    const seconds = hit.model.kind === "video" ? (p.seconds === undefined ? hit.model.seconds?.[0] : Number(p.seconds)) : undefined;
    try { p.quoteUsd = Math.round((await hit.provider.quote(hit.model, { prompt, aspect, quality, seconds, image: typeof p.image === "string" && !!p.image.trim() })) * 1e4) / 1e4; }
    catch (e) { p.quoteProblem = (e as Error).message.slice(0, 200); }
  }

  /** A card that would fail the moment Phil approves is refused now, with the reason going back to the agent. */
  async preflight(a: Pick<Approval, "payload" | "agentId">): Promise<string | undefined> {
    const p = (a.payload ?? {}) as Record<string, unknown>;
    if (p.action !== STUDIO_ACTION) return undefined;
    if (!this.agents().includes(a.agentId)) return `only ${this.agents().join(", ")} can ask the studio for a generation; hand the brief to Joi`;
    const r = this.parse(p);
    if (typeof r === "string") return r;
    if (r.image && !(await loadImage(r.image))) return `the picture "${r.image}" isn't in HQ any more`;
    const caps = studioCaps(this.env);
    if (r.estimateUsd > caps.perItemUsd) return `that would cost about ${usd(r.estimateUsd)}, over the per-generation cap of ${usd(caps.perItemUsd)}; a shorter clip, lower quality or a cheaper model fits (Phil can raise STUDIO_CAP_PER_ITEM_USD)`;
    const spent = await this.spentToday();
    if (spent.usd + this.held + r.estimateUsd > caps.perDayUsd) return `today's studio budget can't take it (about ${usd(r.estimateUsd)}; ${usd(spent.usd + this.held)} of ${usd(caps.perDayUsd)} is spent or promised); it resets at midnight Eastern`;
    return undefined;
  }

  describe(): Record<string, Describer> {
    return {
      [STUDIO_ACTION]: (p) => {
        const r = this.parse(p);
        if (typeof r === "string") return `Can't run as written: ${r}.`;
        const what = r.model.kind === "video" ? `a ${r.ask.seconds}-second ${r.ask.aspect} video` : `one ${r.ask.aspect} image (${r.ask.quality} quality)`;
        return `Sends this prompt${r.image ? " and the picture" : ""} to ${r.provider.label} and makes ${what} with ${r.model.label}, for about ${usd(r.estimateUsd)} charged to your ${r.provider.label} account. It arrives in chat in ${r.model.kind === "video" ? "a few minutes" : "about a minute"}. Editing the text here changes the prompt.`;
      },
    };
  }

  executors(): Record<string, Executor> {
    return {
      [STUDIO_ACTION]: async (a) => {
        const p = { ...((a.payload ?? {}) as Record<string, unknown>) };
        // Priced again at the moment it goes out: the prompt may have been edited, and a quote can move.
        await this.price(p);
        const problem = await this.preflight({ payload: p, agentId: a.agentId });
        if (problem) throw new Error(problem);
        const r = this.parse(p) as Parsed;
        const channel = typeof p.channel === "string" && ["hq", "telegram", "voice", "schedule", "glasses"].includes(p.channel) ? (p.channel as ChatMessage["channel"]) : undefined;
        const job: StudioJob = { id: randomUUID(), at: this.now().toISOString(), agentId: a.agentId, model: r.model.id, kind: r.model.kind, prompt: r.ask.prompt, title: r.title, aspect: r.ask.aspect, quality: r.ask.quality, seconds: r.ask.seconds, image: r.image, estimateUsd: r.estimateUsd, status: "running", channel };
        await this.saveJob(job);
        this.live.add(job.id);
        this.held += job.estimateUsd;
        // In the background: Phil's Approve returns at once, and the work lands in chat when it's made.
        void this.run(job, r).catch(() => undefined);
        return `Started with ${r.model.label} (about ${usd(r.estimateUsd)}). The ${r.model.kind} arrives in chat when it's ready, ${r.model.kind === "video" ? "usually in a few minutes" : "usually within a minute"}.`;
      },
    };
  }

  /** Make it, keep it, book it, and tell Phil. Every ending (made, refused, failed) is said in chat and logged. */
  private async run(job: StudioJob, r: Pick<Parsed, "model" | "provider">, resumed = false): Promise<void> {
    let estimateReleased = false;
    const release = () => { if (!estimateReleased && !resumed) { this.held = Math.max(0, this.held - job.estimateUsd); estimateReleased = true; } };
    try {
      let result: StudioResult;
      if (job.remote) result = await this.wait(job, r.provider);
      else {
        const img = job.image ? await loadImage(job.image) : undefined;
        if (job.image && !img) throw new Error(`the picture to start from isn't in HQ any more`);
        const started = await r.provider.start(r.model, { prompt: job.prompt, aspect: job.aspect, quality: job.quality, seconds: job.seconds, ...(img ? { image: img } : {}) });
        if ("result" in started) result = started.result;
        else { job.remote = started.remote; await this.saveJob(job); result = await this.wait(job, r.provider); }
      }
      const ids: string[] = [];
      for (const o of result.outputs.slice(0, 4)) {
        const mime = sniff(o.data) ?? o.mime;
        if (r.model.kind === "video") ids.push(await saveFile(o.data, mime === "video/webm" ? "webm" : "mp4"));
        else ids.push(await saveImage(o.data, mime, 30 * 1024 * 1024));
      }
      if (!ids.length) throw new StudioSentError(`${r.provider.label} finished but returned nothing to keep`);
      const cost = result.costUsd ?? job.estimateUsd;
      release();
      await this.book(cost);
      Object.assign(job, { status: "done", outputs: ids, costUsd: cost, doneAt: this.now().toISOString() });
      await this.saveJob(job);
      const line = `${job.kind === "video" ? "Video" : "Image"} ready: ${job.title} · ${r.model.label} · ${usd(cost)}${result.costUsd === undefined ? " (estimate; the provider's bill is the truth)" : ""}`;
      await this.deps.log?.(job.agentId, "system", `Studio: ${line} [${ids.join(", ")}]`);
      await this.deps.deliver?.({ role: "agent", agentId: job.agentId, text: line, ...(job.channel ? { channel: job.channel } : {}), ...(job.kind === "video" ? { files: ids.map((id, i) => ({ id, name: `${fileName(job.title)}${ids.length > 1 ? `-${i + 1}` : ""}.${id.split(".").pop()}` })) } : { images: ids }) });
    } catch (e) {
      const msg = (e as Error).message;
      // A request that may have gone through is booked at its estimate: better a day's budget read high than low.
      const maybeCharged = !(e instanceof StudioRefusedError) && (e instanceof StudioSentError || !!job.remote);
      release();
      if (maybeCharged) await this.book(job.estimateUsd).catch(() => undefined);
      Object.assign(job, { status: "failed", error: msg.slice(0, 300), doneAt: this.now().toISOString(), ...(maybeCharged ? { costUsd: job.estimateUsd } : {}) });
      await this.saveJob(job).catch(() => undefined);
      const line = `Couldn't make "${job.title}" with ${r.model.label}: ${msg.slice(0, 300)}.${maybeCharged ? ` ${r.provider.label} may have charged for it (up to ${usd(job.estimateUsd)}, counted against today).` : " Nothing was charged."}`;
      await this.deps.log?.(job.agentId, "error", `Studio: ${line}`);
      await this.deps.deliver?.({ role: "agent", agentId: job.agentId, text: line, ...(job.channel ? { channel: job.channel } : {}) });
    } finally { release(); this.live.delete(job.id); }
  }

  /** Ask the provider about its job until it's done, failed, or has taken too long. */
  private async wait(job: StudioJob, provider: StudioProvider): Promise<StudioResult> {
    if (!provider.poll) throw new StudioSentError(`${provider.label} gave HQ a job to wait on but no way to ask about it`);
    const limit = this.deps.jobTimeoutMs ?? 20 * 60_000;
    const every = this.deps.pollMs ?? 5000;
    const until = Date.parse(job.at) + limit;
    let misses = 0;
    for (;;) {
      try {
        const s = await provider.poll(job.remote!);
        misses = 0;
        if (s.done) return s.result;
      } catch (e) {
        // The job's own failure ends the wait; a network blip while asking doesn't, until it keeps happening.
        if (e instanceof StudioSentError || e instanceof StudioRefusedError || ++misses >= 6) throw e instanceof StudioSentError || e instanceof StudioRefusedError ? e : new StudioSentError((e as Error).message);
      }
      if (this.now().getTime() > until) throw new StudioSentError(`${provider.label} was still working on it after ${Math.round(limit / 60_000)} minutes, so HQ stopped waiting`);
      await new Promise((res) => setTimeout(res, every));
    }
  }

  /**
   * After a restart: a job the provider is running is picked up where it was; one HQ was making itself (a single
   * request that was cut off) can't be, so Phil is told instead of left waiting.
   */
  async resume(): Promise<void> {
    for (const job of (await this.jobs()).filter((j) => j.status === "running" && !this.live.has(j.id))) {
      const hit = this.find(job.model);
      if (hit && job.remote && hit.provider.poll && this.configured(hit.provider)) { this.live.add(job.id); void this.run(job, hit, true).catch(() => undefined); continue; }
      Object.assign(job, { status: "failed", error: "HQ restarted while it was being made", doneAt: this.now().toISOString() });
      await this.saveJob(job);
      await this.deps.deliver?.({ role: "agent", agentId: job.agentId, text: `"${job.title}" was being made when HQ restarted, and the result was lost. ${hit?.provider.label ?? "The provider"} may have charged for it (about ${usd(job.estimateUsd)}). Ask again and it gets a new card.`, ...(job.channel ? { channel: job.channel } : {}) });
    }
  }

  // ---- What the agent sees --------------------------------------------------------------------------------------------

  async toolsFor(agentId: string): Promise<string[]> { return this.agents().includes(agentId) ? ["studio_models", "studio_recent"] : []; }

  tools(): ToolDef[] {
    return [
      defineTool({
        name: "studio_models",
        description: "The image and video models the studio can use right now (id, what each is good at, what it costs, whether it can or must start from a picture), which providers still need a key from Phil, and today's studio spend against the caps. Read it before writing a media.generate card.",
        schema: {},
        handler: async () => {
          if (process.env.JARVIS_MOCK === "1" && !this.models().length) return "(mock) Connected: openai/gpt-image-2.6-sunburst (image, about $0.05 at medium). Nothing is generated in mock mode.";
          const lines: string[] = [];
          for (const p of this.providers) {
            if (!this.configured(p)) { lines.push(`${p.label}: not connected (Phil pastes its key under Settings → Studio). Would add: ${p.models().map((m) => `${m.label} (${m.kind})`).join(", ")}.`); continue; }
            lines.push(`${p.label}: connected.`);
            for (const m of p.models()) {
              const priced = m.estimate({ quality: "medium", aspect: "1:1", seconds: m.seconds?.[0] }) !== undefined;
              const price = !priced ? `${p.label} quotes the exact price on each card${m.seconds ? `; lengths ${m.seconds.join(", ")}s` : ""}`
                : m.kind === "video" ? (m.seconds ?? [5]).map((s) => `${s}s ${usd(m.estimate({ quality: "medium", aspect: "16:9", seconds: s }) ?? 0)}`).join(", ")
                : (["low", "medium", "high"] as const).map((q) => `${q} ${usd(m.estimate({ quality: q, aspect: "1:1" }) ?? 0)}`).join(", ");
              lines.push(`- ${m.id} · ${m.label} · ${m.kind} · ${price} · ${m.image === "required" ? "needs a picture to start from" : m.image === "optional" ? "can start from a picture" : "text only"}. ${m.note}`);
            }
          }
          const s = await this.spentToday(), caps = studioCaps(this.env);
          lines.push(`Today: ${usd(s.usd)} spent over ${s.items} generation(s); caps ${usd(caps.perItemUsd)} per generation and ${usd(caps.perDayUsd)} per day. Aspects: ${STUDIO_ASPECTS.join(", ")}.`);
          return lines.join("\n");
        },
      }),
      defineTool({
        name: "studio_recent",
        description: "The studio's latest generations: when, model, title, status (running, done, failed and why), cost, and the id of each picture made. Use a picture's id as \"image\" on a new card to edit it or to animate it into a video.",
        schema: { limit: z.number().int().min(1).max(30).optional() },
        handler: async ({ limit }) => {
          const jobs = (await this.jobs()).slice(0, limit ?? 10);
          if (!jobs.length) return "Nothing has been generated yet.";
          return jobs.map((j) => `${j.at.slice(0, 16).replace("T", " ")} UTC · ${j.model} · ${j.kind} · "${j.title}" · ${j.status}${j.error ? ` (${j.error.slice(0, 140)})` : ""}${j.costUsd !== undefined ? ` · ${usd(j.costUsd)}` : ""}${j.outputs?.length ? ` · ${j.kind === "image" ? "image id" : "file"}: ${j.outputs.join(", ")}` : ""}\n  prompt: ${j.prompt.slice(0, 300)}`).join("\n");
        },
      }),
    ];
  }

  static promptHint(): string {
    return `The studio makes real images and video. Read studio_models first (what's connected, each model's strengths and price), pick the model that suits the job and say why in a line. A generation = an approval block with "kind":"money", "title":"Generate: <what it is>", "body": the exact prompt, and "payload":{"action":"media.generate","model":"<id from studio_models>","prompt":"<the same exact prompt>","aspect":"1:1|16:9|9:16|3:2|2:3|4:3|3:4","quality":"low|medium|high","title":"<short name>"}; a video adds "seconds", and a model that starts from a picture takes "image": "attached" for the picture Phil sent with his message, or a picture id from studio_recent (to animate an image you made, generate the image first, then file the video card with its id). One card per image or clip; HQ puts the price on the card and the result arrives in chat after Phil approves, so never say it's made until then. Write prompts like a director: subject, setting, light, lens or style, composition, what text appears and where; draft on low quality or a cheap model, finals on high.`;
  }
}

const fileName = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "clip";
