/**
 * Speech for Telegram and HQ. Transcription takes the first key it finds: ELEVENLABS_API_KEY (Scribe), OPENAI_API_KEY
 * (Whisper), GROQ_API_KEY (Whisper on Groq, free tier). Jarvis's spoken replies need ElevenLabs.
 */
type Provider = "elevenlabs" | "openai" | "groq";
/** The services with a key, in the order they're tried. STT_PROVIDER pins one. */
export function transcriptionProviders(): Provider[] {
  const all: Provider[] = [];
  if (process.env.ELEVENLABS_API_KEY) all.push("elevenlabs");
  if (process.env.OPENAI_API_KEY) all.push("openai");
  if (process.env.GROQ_API_KEY) all.push("groq");
  const pin = process.env.STT_PROVIDER as Provider | undefined;
  return pin && all.includes(pin) ? [pin, ...all.filter((p) => p !== pin)] : all;
}
export function transcriptionProvider(): Provider | undefined { return transcriptionProviders()[0]; }

/** Each service in turn; a refusal from one (a key without the speech permission, a quota) falls through to the next. */
export async function transcribe(audio: Buffer, mime: string, f: typeof fetch = fetch): Promise<string> {
  const providers = transcriptionProviders();
  if (!providers.length) throw new Error("no transcription service: set GROQ_API_KEY (free), OPENAI_API_KEY, or an ELEVENLABS_API_KEY with the speech-to-text permission");
  if (audio.length < 500) return "";
  if (audio.length > 25_000_000) throw new Error("that voice note is too long (over 25 MB)");
  const errors: string[] = [];
  for (const provider of providers) {
    try { return await transcribeWith(provider, audio, mime, f); }
    catch (e) { errors.push((e as Error).message); }
  }
  throw new Error(errors.join(" | "));
}

async function transcribeWith(provider: Provider, audio: Buffer, mime: string, f: typeof fetch): Promise<string> {
  const ext = mime.includes("ogg") || mime.includes("opus") ? "ogg" : mime.includes("mp4") || mime.includes("m4a") ? "m4a" : mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `note.${ext}`);
  let url: string, headers: Record<string, string>;
  if (provider === "elevenlabs") { url = "https://api.elevenlabs.io/v1/speech-to-text"; headers = { "xi-api-key": process.env.ELEVENLABS_API_KEY! }; form.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v1"); form.append("language_code", "en"); form.append("tag_audio_events", "false"); }
  else if (provider === "openai") { url = "https://api.openai.com/v1/audio/transcriptions"; headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }; form.append("model", process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe"); form.append("language", "en"); }
  else { url = "https://api.groq.com/openai/v1/audio/transcriptions"; headers = { authorization: `Bearer ${process.env.GROQ_API_KEY}` }; form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo"); form.append("language", "en"); }
  const res = await f(url, { method: "POST", headers, body: form });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 140)}`);
  const j = (await res.json()) as { text?: string };
  return (j.text ?? "").trim();
}

/** Jarvis's voice as MP3, or undefined when ElevenLabs isn't set up. */
export async function synthesize(text: string, f: typeof fetch = fetch): Promise<Buffer | undefined> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || !text.trim()) return undefined;
  const voice = process.env.ELEVENLABS_VOICE_ID || "onwK4e9ZLuTAKqWW03F9";
  const model = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
  const speed = Math.min(1.2, Math.max(0.7, Number(process.env.ELEVENLABS_SPEED ?? 1.1)));
  const res = await f(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, { method: "POST", headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" }, body: JSON.stringify({ text: text.slice(0, 2500), model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, speed } }) });
  if (!res.ok) throw new Error(`voice failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
