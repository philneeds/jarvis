import { test } from "node:test";
{ const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path"); process.env.JARVIS_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tg-up-")); }
import assert from "node:assert/strict";
process.env.JARVIS_MOCK = "1";
const { Jarvis, memoryStore, ModelRouter, mockProvider } = await import("@jarvis/core");
const { TelegramBot } = await import("../src/telegram.js");

function fakeTelegram() {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    sent.push({ method, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, sent };
}

test("Phil chats from Telegram; strangers are ignored", async () => {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  const { f, sent } = fakeTelegram();
  const bot = new TelegramBot(jarvis, { token: "t", chatId: "42", fetch: f, pollTimeout: 0 });
  bot.start();
  await bot.handle({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "@stella how's the board?" } });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(sent.some((s) => s.method === "sendMessage" && /^Jarvis: Stella is on it/.test(String(s.body.text))));
  assert.ok(sent.some((s) => s.method === "sendMessage" && /^Stella: /.test(String(s.body.text))));
  bot.stop();
  await bot.handle({ update_id: 2, message: { message_id: 2, chat: { id: 99 }, text: "hi" } });
  assert.ok(sent.some((s) => s.body.chat_id === 99 && /Not for you/.test(String(s.body.text))));
  assert.equal((await store.chat.list()).some((m) => m.text === "hi"), false);
});

test("approvals arrive with buttons and the button decides", async () => {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  const { f, sent } = fakeTelegram();
  const bot = new TelegramBot(jarvis, { token: "t", chatId: "42", fetch: f, pollTimeout: 0 });
  bot.start();
  const a = await jarvis.requestApproval({ agentId: "stephanie", kind: "send", title: "Reply to the Smiths", body: "the draft" });
  await new Promise((r) => setTimeout(r, 50));
  const announce = sent.find((s) => s.method === "sendMessage" && /Reply to the Smiths/.test(String(s.body.text)));
  assert.ok(announce);
  const kb = (announce!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]!;
  assert.equal(kb[0]!.callback_data, `apr:${a.id}:approved`);
  await bot.handle({ update_id: 3, callback_query: { id: "cq", from: { id: 42 }, data: kb[1]!.callback_data, message: { message_id: 7, chat: { id: 42 } } } });
  assert.equal((await store.approvals.get(a.id))?.status, "rejected");
  assert.ok(sent.some((s) => s.method === "editMessageText" && /Rejected/.test(String(s.body.text))));
  bot.stop();
});

test("attention items reach Telegram with Done and Snooze buttons", async () => {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  const { f, sent } = fakeTelegram();
  const bot = new TelegramBot(jarvis, { token: "t", chatId: "42", fetch: f, pollTimeout: 0 });
  bot.start();
  const item = await jarvis.raiseAttention({ title: "Revoke the old GitHub token", why: "Repo is public now.", agentId: "monica" });
  await new Promise((r) => setTimeout(r, 50));
  const msg = sent.find((s) => s.method === "sendMessage" && /Revoke the old GitHub token/.test(String(s.body.text)));
  assert.ok(msg);
  const kb = (msg!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]!;
  await bot.handle({ update_id: 9, callback_query: { id: "cq2", from: { id: 42 }, data: kb[0]!.callback_data, message: { message_id: 8, chat: { id: 42 } } } });
  assert.equal((await jarvis.attention(true))[0]!.status, "done");
  assert.equal(item.id, (await jarvis.attention(true))[0]!.id);
  bot.stop();
});


test("a photo on Telegram reaches Jarvis with the picture attached", async () => {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1b9b3a60000000049454e44ae426082", "hex");
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/file/bot")) return new Response(png, { headers: { "content-type": "image/png" } });
    const method = u.split("/").pop()!;
    sent.push({ method, body: JSON.parse(String(init?.body)) });
    if (method === "getFile") return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/file_1.png" } }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ ok: true, result: [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const bot = new TelegramBot(jarvis, { token: "t", chatId: "42", fetch: f, pollTimeout: 0 });
  bot.start();
  await bot.handle({ update_id: 9, message: { message_id: 9, chat: { id: 42 }, caption: "@joi thoughts on this?", photo: [{ file_id: "small", width: 90, height: 90 }, { file_id: "big", width: 1280, height: 1280 }] } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent.find((s) => s.method === "getFile")?.body.file_id, "big", "takes the largest size");
  const phil = (await store.chat.list()).find((m) => m.role === "phil")!;
  assert.equal(phil.text, "@joi thoughts on this?");
  assert.equal(phil.images?.length, 1);
  assert.ok(sent.some((s) => s.method === "sendMessage" && /^Joi: \(saw 1 image\)/.test(String(s.body.text))), "Joi answers having seen it");
  bot.stop();
});

test("a spreadsheet sent on Telegram becomes ProEdge sales data; the deck comes back as a document", async () => {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  const sent: { method: string; body: unknown }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/file/bot")) return new Response("rep,closed\nAna,5\nBen,3\n");
    const method = u.split("/").pop()!;
    sent.push({ method, body: init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body)) });
    const result = method === "getFile" ? { file_path: "documents/file_1.csv" } : [];
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const bot = new TelegramBot(jarvis, { token: "t", chatId: "42", fetch: f, pollTimeout: 0 });
  bot.start();
  await bot.handle({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, document: { file_id: "abc", file_name: "week.csv", mime_type: "text/csv" } } });
  const { listDataFiles, SCHEDULES, runRoutine } = await import("@jarvis/core");
  assert.equal((await listDataFiles(store, "proedge"))[0]?.rows, 3);
  assert.ok(sent.some((s) => s.method === "sendMessage" && /Saved week\.csv \(3 rows\)/.test(String((s.body as { text: string }).text))));
  await runRoutine(jarvis, { ...SCHEDULES.find((s) => s.id === "stevon-weekly")!, task: "Build the deck for Tuesday." }, { direct: true });
  await new Promise((r) => setTimeout(r, 200));
  const doc = sent.find((s) => s.method === "sendDocument");
  assert.ok(doc, "the deck is sent as a document");
  assert.match(((doc!.body as FormData).get("document") as File).name, /\.pptx$/);
  bot.stop();
});

test("a voice note on Telegram is transcribed, shown back, answered, and the answer is spoken back too", async () => {
  const store = memoryStore();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } }) });
  const sent: { method: string; body: unknown }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/file/bot")) return new Response(Buffer.alloc(2000, 1));
    const method = u.split("/").pop()!;
    sent.push({ method, body: init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: method === "getFile" ? { file_path: "voice/file_7.oga" } : [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  let heardMime = "";
  const bot = new TelegramBot(jarvis, { token: "t", chatId: "42", fetch: f, pollTimeout: 0, transcribe: async (_a, mime) => { heardMime = mime; return "what is on today"; }, synthesize: async (text) => Buffer.from(`mp3:${text.slice(0, 20)}`) });
  bot.start();
  await bot.handle({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, voice: { file_id: "v1", mime_type: "audio/ogg", duration: 3 } } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(heardMime, "audio/ogg");
  const texts = sent.filter((s) => s.method === "sendMessage").map((s) => String((s.body as { text: string }).text));
  assert.ok(texts.some((t) => t === 'Heard: "what is on today"'), "Phil sees what was heard");
  assert.ok(texts.some((t) => /^Jarvis: /.test(t)), "Jarvis answered in text");
  const audio = sent.find((s) => s.method === "sendAudio");
  assert.ok(audio, "and the answer went back as audio");
  assert.equal(((audio!.body as FormData).get("audio") as File).name, "jarvis.mp3");
  assert.equal((await store.chat.list(10)).find((m) => m.role === "phil")?.text, "what is on today");
  bot.stop();
  // Without any transcription set up, a voice note gets a clear answer instead of silence.
  const sent2: string[] = [];
  const f2 = (async (url: string | URL | Request, init?: RequestInit) => { if (String(url).endsWith("sendMessage")) sent2.push(JSON.parse(String(init?.body)).text); return new Response(JSON.stringify({ ok: true, result: [] }), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
  const bare = new TelegramBot(jarvis, { token: "t", chatId: "42", fetch: f2, pollTimeout: 0 });
  await bare.handle({ update_id: 2, message: { message_id: 2, chat: { id: 42 }, voice: { file_id: "v2" } } });
  assert.match(sent2[0] ?? "", /can't hear voice notes yet/);
});

test("transcription falls through: an ElevenLabs key without the speech permission gives way to Groq", async () => {
  const { transcribe, transcriptionProviders } = await import("../src/speech.js");
  const saved = { ...process.env };
  process.env.ELEVENLABS_API_KEY = "el"; process.env.GROQ_API_KEY = "gq"; delete process.env.OPENAI_API_KEY; delete process.env.STT_PROVIDER;
  try {
    assert.deepEqual(transcriptionProviders(), ["elevenlabs", "groq"]);
    const tried: string[] = [];
    const f = (async (url: string | URL | Request) => { tried.push(new URL(String(url)).hostname); return String(url).includes("elevenlabs") ? new Response('{"detail":{"message":"missing the permission speech_to_text"}}', { status: 401 }) : Response.json({ text: "did they work" }); }) as typeof fetch;
    assert.equal(await transcribe(Buffer.alloc(2000, 1), "audio/ogg", f), "did they work");
    assert.deepEqual(tried, ["api.elevenlabs.io", "api.groq.com"]);
    process.env.STT_PROVIDER = "groq";
    assert.deepEqual(transcriptionProviders(), ["groq", "elevenlabs"], "STT_PROVIDER pins the first choice");
    const all401 = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(transcribe(Buffer.alloc(2000, 1), "audio/ogg", all401), /groq 401: no \| elevenlabs 401: no/);
  } finally { process.env = saved; }
});
