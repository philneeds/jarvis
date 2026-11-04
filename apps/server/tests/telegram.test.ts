import { test } from "node:test";
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
  const bot = new TelegramBot(jarvis, { token: "t", chatId: "42", fetch: f });
  await bot.handle({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "@stella how's the board?" } });
  assert.ok(sent.some((s) => s.method === "sendMessage" && /^Stella: /.test(String(s.body.text))));
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
