import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Studio, STUDIO_ACTION, STUDIO_JOBS_KEY, STUDIO_SPEND_KEY, CHARTERS, Jarvis, ModelRouter, memoryStore, loadImage, loadFile, saveImage, type Approval, type ChatMessage, type StudioJob } from "../src/index.js";

// Generated files go to a folder of this test's own, and no key comes from the machine's environment.
process.env.JARVIS_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "studio-test-"));
for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "HIGGSFIELD_API_KEY", "STUDIO_AGENTS"]) delete process.env[k];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(300, 3)]);
const HF = "https://api.higgsfield.ai";
const HF_KEY = "kid123:sec456";
const REQ = "11111111-2222-3333-4444-555555555555";

type Call = { method: string; url: string; headers: Record<string, string>; body?: any; bytes?: number };
/** The four providers, played. Every call is recorded so a test can say what was and wasn't sent. */
function fakeWorld(o: { hfStatuses?: object[]; estimate?: string; estimateFails?: boolean; openaiStatus?: number } = {}) {
  const calls: Call[] = [];
  const statuses = [...(o.hfStatuses ?? [{ status: "queued" }, { status: "in_progress" }, { status: "completed", video: { url: "https://cdn.higgs.example/out.mp4" } }])];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = init?.body;
    calls.push({ method, url, headers, ...(typeof raw === "string" ? { body: JSON.parse(raw) } : raw ? { bytes: (raw as Uint8Array).length } : {}) });
    if (url === "https://api.openai.com/v1/images/generations" || url === "https://api.openai.com/v1/images/edits") {
      if (o.openaiStatus) return json({ error: { message: "Your organization must be verified to use the model" } }, o.openaiStatus);
      return json({ data: [{ b64_json: PNG.toString("base64") }], usage: { input_tokens: 40, output_tokens: 2000, input_tokens_details: { image_tokens: 0, text_tokens: 40 } } });
    }
    if (url.startsWith("https://generativelanguage.googleapis.com/")) return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] }, finishReason: "STOP" }] });
    if (url.startsWith("https://api.x.ai/v1/images/")) return json({ data: [{ b64_json: PNG.toString("base64") }], usage: { cost_in_usd_ticks: 400_000_000 } });
    if (url.startsWith(`${HF}/estimate/`)) return o.estimateFails ? json({ detail: "model disabled" }, 503) : json({ usd: o.estimate ?? "0.72" });
    if (url === `${HF}/files/generate-upload-url`) return json({ public_url: "https://files.higgs.example/in.png", upload_url: "https://s3.example/put?sig=1", upload_headers: { "Content-Type": "image/png", "x-amz-tagging": "retention=temporary" } });
    if (url === "https://s3.example/put?sig=1") return new Response("", { status: 200 });
    if (url === `${HF}/requests/${REQ}/status`) return json({ request_id: REQ, ...(statuses.length > 1 ? statuses.shift()! : statuses[0]!) });
    if (url.startsWith(`${HF}/`) && method === "POST") return json({ status: "queued", request_id: REQ, status_url: `${HF}/requests/${REQ}/status` });
    if (url === "https://cdn.higgs.example/out.mp4") return new Response(new Uint8Array(MP4), { status: 200, headers: { "content-type": "video/mp4" } });
    return json({ error: { message: `unexpected ${method} ${url}` } }, 404);
  }) as typeof fetch;
  return { f, calls };
}

function setup(env: Record<string, string>, world = fakeWorld(), extra: { conversation?: () => { channel?: ChatMessage["channel"]; images?: string[] } } = {}) {
  const store = memoryStore();
  const said: Omit<ChatMessage, "id" | "at">[] = [];
  const logs: string[] = [];
  const studio = new Studio({ store, env, fetch: world.f, pollMs: 1, deliver: async (m) => { said.push(m); }, log: async (_a, kind, s) => { logs.push(`${kind}: ${s}`); }, ...extra });
  const card = (payload: Record<string, unknown>, agentId = "joi") => ({ id: "a1", at: new Date().toISOString(), agentId, kind: "money", title: "Generate", body: String(payload.prompt ?? ""), status: "approved", payload: { action: STUDIO_ACTION, ...payload } }) as Approval;
  /** Approve a card and wait for the background job to say how it ended. */
  const approve = async (payload: Record<string, unknown>) => {
    const before = said.length;
    const started = await studio.executors()[STUDIO_ACTION]!(card(payload), undefined as never);
    for (let i = 0; i < 400 && said.length === before; i++) await new Promise((r) => setTimeout(r, 5));
    return { started: String(started), message: said[said.length - 1]! };
  };
  return { store, studio, said, logs, card, approve, ...world };
}

test("an OpenAI image: priced on the card, made on approval, shown in chat, and booked at what the usage says", async () => {
  const s = setup({ OPENAI_API_KEY: "sk-test-openai" });
  const payload = { model: "openai/gpt-image-2.6-sunburst", prompt: "A red fox logo, flat, on white", aspect: "16:9", quality: "medium", title: "Fox logo" };
  assert.equal(await s.studio.preflight(s.card(payload)), undefined);
  const effect = s.studio.describe()[STUDIO_ACTION]!({ action: STUDIO_ACTION, ...payload }, s.card(payload));
  assert.match(effect, /one 16:9 image \(medium quality\) with GPT Image 2\.6 Sunburst, for about \$0\.041 charged to your OpenAI account/);
  assert.equal(s.calls.length, 0, "nothing is sent before approval");

  const { started, message } = await s.approve(payload);
  assert.match(started, /^Started with GPT Image 2\.6 Sunburst/);
  const gen = s.calls.find((c) => c.url.endsWith("/images/generations"))!;
  assert.deepEqual(gen.body, { model: "gpt-image-2.6-sunburst", prompt: payload.prompt, size: "1536x1024", quality: "medium", n: 1, output_format: "png" });
  assert.equal(gen.headers.authorization, "Bearer sk-test-openai");
  assert.equal(message.role, "agent"); assert.equal(message.agentId, "joi");
  assert.match(message.text, /^Image ready: Fox logo · GPT Image 2\.6 Sunburst · \$0\.060$/);
  const img = await loadImage(message.images![0]!);
  assert.equal(img?.mime, "image/png");
  assert.deepEqual(await s.store.settings.get(STUDIO_SPEND_KEY, null).then((x: any) => [x.usd, x.items]), [0.0602, 1]);
  const [job] = await s.store.settings.get<StudioJob[]>(STUDIO_JOBS_KEY, []);
  assert.equal(job!.status, "done"); assert.deepEqual(job!.outputs, message.images);
  assert.ok(!JSON.stringify([s.said, s.logs, job]).includes("sk-test-openai"), "the key reaches no message, log or job");
});

test("a card that can't run is refused before Phil sees it, in words the agent can act on", async () => {
  const s = setup({ OPENAI_API_KEY: "k" });
  const ok = { model: "openai/gpt-image-2.6-flare", prompt: "a cat" };
  assert.match((await s.studio.preflight(s.card({ ...ok, model: "midjourney/v9" })))!, /"model" must be one of the studio's model ids \(openai\/gpt-image-2\.6-sunburst, openai\/gpt-image-2\.6-flare\)/);
  assert.match((await s.studio.preflight(s.card({ ...ok, model: "google/gemini-3-pro-image" })))!, /Google isn't connected: Phil pastes its key under Settings → Studio/);
  assert.match((await s.studio.preflight(s.card({ ...ok, prompt: " " })))!, /"prompt" is missing/);
  assert.match((await s.studio.preflight(s.card({ ...ok, aspect: "5:1" })))!, /"aspect" must be one of/);
  assert.match((await s.studio.preflight(s.card({ ...ok, image: "https://example.com/x.png" })))!, /a link can't be used/);
  assert.match((await s.studio.preflight(s.card({ ...ok, image: "attached" })))!, /no picture is attached to Phil's message/);
  assert.match((await s.studio.preflight(s.card(ok, "lip")))!, /only joi can ask the studio/);
  assert.equal(s.calls.length, 0);
});

test("the caps hold behind the approval: one generation, and the day", async () => {
  const s = setup({ OPENAI_API_KEY: "k", STUDIO_CAP_PER_DAY_USD: "0.25", STUDIO_CAP_PER_ITEM_USD: "0.2" });
  const high = { model: "openai/gpt-image-2.6-sunburst", prompt: "a poster", quality: "high" };
  assert.match((await s.studio.preflight(s.card(high)))!, /about \$0\.21, over the per-generation cap of \$0\.20/);
  const wide = { ...high, aspect: "16:9" };
  assert.equal(await s.studio.preflight(s.card(wide)), undefined);
  await s.approve(wide);
  await s.approve(wide);
  assert.match((await s.studio.preflight(s.card(wide)))!, /today's studio budget can't take it/);
  await assert.rejects(s.studio.executors()[STUDIO_ACTION]!(s.card(wide), undefined as never), /today's studio budget/);
});

test("a provider's refusal after approval is said in chat, and a refused request isn't counted as spent", async () => {
  const s = setup({ OPENAI_API_KEY: "k" }, fakeWorld({ openaiStatus: 403 }));
  const { message } = await s.approve({ model: "openai/gpt-image-2.6-flare", prompt: "a cat", title: "Cat" });
  assert.match(message.text, /^Couldn't make "Cat" with GPT Image 2\.6 Flare: OpenAI 403: Your organization must be verified.*Nothing was charged\.$/);
  assert.equal((await s.studio.spentToday()).usd, 0);
  assert.equal((await s.studio.jobs())[0]!.status, "failed");
});

test("Google and xAI: the request each one documents, and xAI's own cost figure is what's booked", async () => {
  const s = setup({ GEMINI_API_KEY: "g-key", XAI_API_KEY: "x-key" });
  await s.approve({ model: "google/gemini-3-pro-image", prompt: "a watch on marble", aspect: "3:4", quality: "high" });
  const g = s.calls.find((c) => c.url.includes(":generateContent"))!;
  assert.equal(g.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent");
  assert.equal(g.headers["x-goog-api-key"], "g-key");
  assert.deepEqual(g.body.generationConfig, { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:4", imageSize: "4K" } });
  assert.equal((await s.studio.spentToday()).usd, 0.24);
  const { message } = await s.approve({ model: "xai/grok-imagine-image-2.0", prompt: "a meme" });
  const x = s.calls.find((c) => c.url === "https://api.x.ai/v1/images/generations")!;
  assert.deepEqual(x.body, { model: "grok-imagine-image-2.0", prompt: "a meme", n: 1, response_format: "b64_json", aspect_ratio: "1:1", resolution: "1.5k" });
  assert.match(message.text, /Grok Imagine 2\.0 · \$0\.040$/);
});

test("a Higgsfield video: Higgsfield's own quote is the card's price, the job is followed to the end, and the clip lands as a file", async () => {
  const s = setup({ HIGGSFIELD_API_KEY: HF_KEY }, fakeWorld(), { conversation: () => ({ channel: "telegram" }) });
  // The agent's own number is thrown away; HQ asks Higgsfield.
  const payload = (await s.studio.normalize({ action: STUDIO_ACTION, model: "higgsfield/kling-3.0", prompt: "A drone shot over Rochester at dusk", aspect: "9:16", seconds: 10, title: "Rochester dusk", quoteUsd: 0.01 }))!;
  assert.equal(payload.quoteUsd, 0.72); assert.equal(payload.channel, "telegram");
  const est = s.calls[0]!;
  assert.equal(est.url, `${HF}/estimate/kling-video/v3.0/pro/text-to-video`);
  assert.equal(est.headers.authorization, `Key ${HF_KEY}`);
  assert.match(s.studio.describe()[STUDIO_ACTION]!(payload, s.card(payload)), /a 10-second 9:16 video with Kling 3\.0 Pro, for about \$0\.72 charged to your Higgsfield account/);
  assert.match((await s.studio.preflight(s.card({ ...payload, seconds: 7 })))!, /"seconds" for Kling 3\.0 Pro must be 5 or 10 or 15/);

  const { message } = await s.approve(payload);
  const submit = s.calls.find((c) => c.url === `${HF}/kling-video/v3.0/pro/text-to-video`)!;
  assert.deepEqual(submit.body, { prompt: "A drone shot over Rochester at dusk", duration: 10, aspect_ratio: "9:16", sound: "on" });
  assert.ok(submit.headers["idempotency-key"]);
  assert.equal(s.calls.filter((c) => c.url.endsWith("/status")).length, 3, "queued, in progress, completed");
  assert.equal(s.calls.find((c) => c.url.startsWith("https://cdn."))!.headers.authorization, undefined, "the finished file is fetched without HQ's key");
  assert.match(message.text, /^Video ready: Rochester dusk · Kling 3\.0 Pro · \$0\.72 \(estimate/);
  assert.equal(message.channel, "telegram");
  assert.equal(message.files![0]!.name, "rochester-dusk.mp4");
  assert.equal((await loadFile(message.files![0]!.id))?.mime, "video/mp4");
  assert.equal((await s.studio.spentToday()).usd, 0.72);
});

test("a video from a picture: the picture goes to Higgsfield's upload store without HQ's key, then to the image-to-video model", async () => {
  const pic = await saveImage(PNG, "image/png");
  const s = setup({ HIGGSFIELD_API_KEY: HF_KEY }, fakeWorld(), { conversation: () => ({ images: [pic] }) });
  const payload = (await s.studio.normalize({ action: STUDIO_ACTION, model: "higgsfield/seedance-2.0", prompt: "she turns and smiles", image: "attached", quality: "high" }))!;
  assert.equal(payload.image, pic);
  await s.approve(payload);
  const put = s.calls.find((c) => c.method === "PUT")!;
  assert.equal(put.headers.authorization, undefined);
  assert.equal(put.headers["x-amz-tagging"], "retention=temporary");
  assert.equal(put.bytes, PNG.length);
  const submit = s.calls.find((c) => c.url === `${HF}/bytedance/seedance-2.0/image-to-video`)!;
  assert.deepEqual(submit.body, { prompt: "she turns and smiles", duration: 5, image_url: "https://files.higgs.example/in.png", resolution: "1080p", generate_audio: true });
});

test("Higgsfield: no quote means no card, and a job it fails or blocks isn't counted as spent", async () => {
  const noPrice = setup({ HIGGSFIELD_API_KEY: HF_KEY }, fakeWorld({ estimateFails: true }));
  const p = (await noPrice.studio.normalize({ action: STUDIO_ACTION, model: "higgsfield/wan-3.0", prompt: "waves" }))!;
  assert.match((await noPrice.studio.preflight(noPrice.card(p)))!, /Higgsfield couldn't price it, so HQ can't put a cost on the card \(Higgsfield 503: model disabled\)/);

  const blocked = setup({ HIGGSFIELD_API_KEY: HF_KEY }, fakeWorld({ hfStatuses: [{ status: "nsfw" }] }));
  const { message } = await blocked.approve({ model: "higgsfield/wan-3.0", prompt: "waves", title: "Waves" });
  assert.match(message.text, /Couldn't make "Waves" with Wan 3\.0: Higgsfield's content filter blocked it; reword the prompt\. Nothing was charged\./);
  assert.equal((await blocked.studio.spentToday()).usd, 0);
});

test("after a restart a Higgsfield job is picked up where it was; a single request that was cut off is reported", async () => {
  const s = setup({ HIGGSFIELD_API_KEY: HF_KEY, OPENAI_API_KEY: "k" }, fakeWorld({ hfStatuses: [{ status: "completed", video: { url: "https://cdn.higgs.example/out.mp4" } }] }));
  const base = { at: new Date().toISOString(), agentId: "joi", aspect: "16:9", quality: "medium", status: "running" } as const;
  await s.store.settings.set(STUDIO_JOBS_KEY, [
    { ...base, id: "j1", model: "higgsfield/kling-3.0", kind: "video", prompt: "p", title: "Left running", seconds: 5, estimateUsd: 0.5, remote: `video:${REQ}` },
    { ...base, id: "j2", model: "openai/gpt-image-2.6-flare", kind: "image", prompt: "p", title: "Cut off", estimateUsd: 0.05 },
  ] satisfies StudioJob[]);
  await s.studio.resume();
  for (let i = 0; i < 400 && s.said.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(s.said.some((m) => /"Cut off" was being made when HQ restarted/.test(m.text)));
  assert.ok(s.said.some((m) => /^Video ready: Left running/.test(m.text) && m.files?.length === 1));
  assert.deepEqual((await s.studio.jobs()).map((j) => j.status).sort(), ["done", "failed"]);
});

test("in HQ: Joi has the studio, its card always waits for Phil, and editing the card edits the prompt", async () => {
  process.env.JARVIS_MOCK = "1";
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store }) });
  const world = fakeWorld();
  jarvis.useStudio({ env: { XAI_API_KEY: "x-key" }, fetch: world.f, pollMs: 1 });
  assert.ok(CHARTERS.joi!.tools!.includes("studio_models"));
  assert.deepEqual(await jarvis.studio.toolsFor("joi"), ["studio_models", "studio_recent"]);
  assert.deepEqual(await jarvis.studio.toolsFor("lip"), []);
  const listing = await jarvis.allTools().find((t) => t.name === "studio_models")!.handler({}, { store, agentId: "joi" });
  assert.match(listing, /xAI: connected\.\n- xai\/grok-imagine-image-2\.0 · Grok Imagine 2\.0 · image · low \$0\.040, medium \$0\.040, high \$0\.040 · can start from a picture/);
  assert.match(listing, /Higgsfield: not connected \(Phil pastes its key under Settings → Studio\)\. Would add: Kling 3\.0 Pro \(video\)/);

  const a = await jarvis.requestApproval({ agentId: "joi", kind: "money", title: "Generate: skyline", body: "a neon skyline", payload: { action: STUDIO_ACTION, model: "xai/grok-imagine-image-2.0", prompt: "a neon skyline" } });
  assert.equal(a.status, "pending");
  assert.match(a.effect!, /makes one 1:1 image \(medium quality\) with Grok Imagine 2\.0, for about \$0\.040/);
  assert.equal(world.calls.length, 0);
  await jarvis.decide(a.id, "edited", undefined, { body: "a neon skyline at dawn" });
  for (let i = 0; i < 400 && !(await store.chat.list(50)).some((m) => /^Image ready/.test(m.text)); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(world.calls.find((c) => c.url.endsWith("/images/generations"))!.body.prompt, "a neon skyline at dawn");
  const done = (await store.chat.list(50)).find((m) => /^Image ready/.test(m.text))!;
  assert.equal(done.agentId, "joi"); assert.equal(done.images?.length, 1);
});
