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
  const model = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";

  r.get("/status", (c) => c.json({ available: !!key, provider: key ? "elevenlabs" : "browser" }));
  r.post("/", async (c) => {
    if (!key) return c.json({ error: "no server voice configured" }, 404);
    const p = z.object({ text: z.string().min(1).max(2500) }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "text required" }, 400);
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: p.data.text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 } }),
    });
    if (!res.ok) return c.json({ error: `voice failed: ${res.status} ${(await res.text()).slice(0, 200)}` }, 502);
    return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  });
  return r;
}
