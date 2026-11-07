import { Hono } from "hono";
import { z } from "zod";

/**
 * Jarvis's voice. With ELEVENLABS_API_KEY set, /api/tts returns MP3 audio from ElevenLabs
 * (ELEVENLABS_VOICE_ID picks the voice; the default is a calm British male). Without a key the route
 * reports unavailable and HQ falls back to the browser's own voices.
 */
export function ttsRoutes() {
  const r = new Hono();
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID || "onwK4e9ZLuTAKqWW03F9"; // "Daniel"
  // Flash is ElevenLabs' lowest-latency model; set ELEVENLABS_MODEL to trade speed for polish.
  const model = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
  const sttModel = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
  // 1.0 is the voice's natural pace; ElevenLabs accepts 0.7–1.2.
  const speed = Math.min(1.2, Math.max(0.7, Number(process.env.ELEVENLABS_SPEED ?? 1.2)));

  r.get("/status", (c) => c.json({ available: !!key, provider: key ? "elevenlabs" : "browser", stt: !!key || !!process.env.OPENAI_API_KEY || !!process.env.GROQ_API_KEY }));
  /** Speech to text: the raw audio of one utterance in the body (audio/webm or audio/mp4), the words back. */
  r.post("/stt", async (c) => {
    if (!key) return c.json({ error: "no server transcription configured" }, 404);
    const audio = await c.req.arrayBuffer();
    if (audio.byteLength < 1000) return c.json({ text: "" });
    if (audio.byteLength > 10_000_000) return c.json({ error: "audio too long" }, 413);
    const type = c.req.header("content-type")?.split(";")[0] || "audio/webm";
    const form = new FormData();
    form.append("model_id", sttModel);
    form.append("file", new Blob([audio], { type }), `utterance.${type.includes("mp4") ? "mp4" : "webm"}`);
    form.append("language_code", "en");
    form.append("tag_audio_events", "false");
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form });
    if (!res.ok) return c.json({ error: `transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}` }, 502);
    const j = (await res.json()) as { text?: string };
    return c.json({ text: (j.text ?? "").trim() });
  });
  r.post("/", async (c) => {
    if (!key) return c.json({ error: "no server voice configured" }, 404);
    const p = z.object({ text: z.string().min(1).max(2500) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "text required" }, 400);
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: p.data.text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, speed } }),
    });
    if (!res.ok) return c.json({ error: `voice failed: ${res.status} ${(await res.text()).slice(0, 200)}` }, 502);
    return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  });
  return r;
}
