import { bus, getAgent, type Approval, type Jarvis, type JarvisEvent, saveImage, addDataFile, setTemplate, deckFile } from "@jarvis/core";
import { transcribe as transcribeDefault, synthesize as synthesizeDefault, transcriptionProvider } from "./speech.js";

/**
 * Two-way Telegram: Phil talks to Jarvis from his phone, and approvals arrive with Approve / Reject buttons.
 *   TELEGRAM_BOT_TOKEN   from @BotFather
 *   TELEGRAM_CHAT_ID     Phil's chat id; every other sender is ignored
 * Long polling, no public webhook needed.
 */
export interface TelegramOptions { token: string; chatId: string; fetch?: typeof fetch; pollTimeout?: number; transcribe?: (audio: Buffer, mime: string) => Promise<string>; synthesize?: (text: string) => Promise<Buffer | undefined> }

export class TelegramBot {
  private f: typeof fetch;
  private offset = 0;
  private running = false;
  private off?: () => void;
  /** Phil's messages that came in as voice notes: the replies to those go back as audio too (when a voice is set up). */
  private voiceAsked = new Set<string>();
  constructor(private jarvis: Jarvis, private opts: TelegramOptions) { this.f = opts.fetch ?? fetch; }

  static fromEnv(jarvis: Jarvis): TelegramBot | undefined {
    const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = process.env;
    return token && chatId ? new TelegramBot(jarvis, { token, chatId }) : undefined;
  }

  private api(method: string, body: unknown) {
    return this.f(`https://api.telegram.org/bot${this.opts.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async send(text: string, extra: Record<string, unknown> = {}) {
    for (let i = 0; i < text.length; i += 3900) await this.api("sendMessage", { chat_id: this.opts.chatId, text: text.slice(i, i + 3900), ...(i + 3900 >= text.length ? extra : {}) }).catch(() => undefined);
  }

  /** Jarvis's reply as a voice bubble, after the text, for a voice note when Phil has /voice on. */
  async sendSpoken(text: string) {
    try {
      const audio = await (this.opts.synthesize ?? synthesizeDefault)(text.replace(/[*_`#>]/g, ""));
      if (!audio) return;
      const form = new FormData();
      form.append("chat_id", this.opts.chatId);
      form.append("voice", new Blob([new Uint8Array(audio)], { type: "audio/ogg" }), "jarvis.ogg");
      await this.f(`https://api.telegram.org/bot${this.opts.token}/sendVoice`, { method: "POST", body: form });
    } catch { /* the text already went */ }
  }

  /** Send files (decks) as Telegram documents. */
  async sendFiles(files: { id: string; name: string }[] = []) {
    for (const f of files.slice(0, 3)) {
      const d = await deckFile(this.jarvis.store, f.id);
      if (!d) continue;
      const form = new FormData();
      form.append("chat_id", this.opts.chatId);
      form.append("document", new Blob([new Uint8Array(d.data)], { type: d.mime }), d.name);
      await this.f(`https://api.telegram.org/bot${this.opts.token}/sendDocument`, { method: "POST", body: form }).catch(() => undefined);
    }
  }

  start() {
    this.running = true;
    this.off = bus.onEvent((e: JarvisEvent) => {
      if (e.type === "chat.message" && e.message.channel === "telegram" && e.message.role !== "phil") {
        const o = e.message;
        const who = o.role === "jarvis" ? "Jarvis" : o.role === "system" ? "HQ" : getAgent(o.agentId ?? "")?.name ?? o.agentId ?? "Agent";
        void this.send(`${who}: ${o.text}`).then(() => this.sendFiles(o.files)).then(() => { if (o.replyTo && this.voiceAsked.has(o.replyTo) && o.kind !== "ack") return this.sendSpoken(o.text); });
      }
      if (e.type === "report") void this.send(`${e.title} · ${e.agentId === "jarvis" ? "Jarvis" : getAgent(e.agentId)?.name ?? e.agentId}\n\n${e.text}`).then(() => this.sendFiles(e.files));
      if (e.type === "approval.new") void this.announce(e.approval);
      if (e.type === "attention" && e.change === "raised") void this.send(`Needs you · ${getAgent(e.item.agentId)?.name ?? e.item.agentId}\n${e.item.title}\n\n${e.item.why.slice(0, 800)}${e.item.due ? `\nDue ${e.item.due}` : ""}`, { reply_markup: { inline_keyboard: [[{ text: "✔ Done", callback_data: `att:${e.item.id}:done` }, { text: "💤 Snooze 3d", callback_data: `att:${e.item.id}:snoozed` }]] } });
    });
    void this.loop();
  }
  stop() { this.running = false; this.off?.(); }

  /** Fetch a file Phil sent (Telegram bots can download up to 20 MB). */
  private async download(fileId: string): Promise<{ path: string; data: Buffer }> {
    const r = (await (await this.api("getFile", { file_id: fileId })).json()) as { ok: boolean; result?: { file_path?: string; file_size?: number } };
    const fp = r.result?.file_path;
    if (!r.ok || !fp) throw new Error("Telegram didn't give me the file (bots can only download files up to 20 MB)");
    const res = await this.f(`https://api.telegram.org/file/bot${this.opts.token}/${fp}`);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return { path: fp, data: Buffer.from(await res.arrayBuffer()) };
  }

  /** Fetch a photo Phil sent and keep it as an upload. */
  private async downloadImage(fileId: string): Promise<string> {
    const { path: fp, data } = await this.download(fileId);
    const ext = fp.split(".").pop()?.toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
    return saveImage(data, mime);
  }

  private async announce(a: Approval) {
    const who = getAgent(a.agentId)?.name ?? a.agentId;
    await this.send(`Approval · ${who} · ${a.kind}\n${a.title}\n\n${a.body.slice(0, 1500)}${a.context ? `\n\nContext: ${a.context.slice(0, 800)}` : ""}${a.effect ? `\n\nIf you approve: ${a.effect}` : ""}\n\nTo ask ${who} about it or edit the text, open Needs you in HQ.`, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `apr:${a.id}:approved` }, { text: "❌ Reject", callback_data: `apr:${a.id}:rejected` }]] },
    });
  }

  private async loop() {
    while (this.running) {
      try {
        const res = await this.api("getUpdates", { offset: this.offset, timeout: this.opts.pollTimeout ?? 30, allowed_updates: ["message", "callback_query"] });
        const j = (await res.json()) as { ok: boolean; result?: Update[] };
        for (const u of j.result ?? []) { this.offset = u.update_id + 1; await this.handle(u); }
        // Yield to timers between polls (a fast-returning poll must not starve the event loop).
        await new Promise((r) => setTimeout(r, j.result?.length ? 50 : 500));
      } catch (e) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  /** One update. Public for tests. */
  async handle(u: Update) {
    if (u.callback_query) {
      const q = u.callback_query;
      if (String(q.from.id) !== this.opts.chatId && String(q.message?.chat.id) !== this.opts.chatId) return;
      const att = q.data?.match(/^att:([^:]+):(done|snoozed)$/);
      if (att) {
        const item = await this.jarvis.attentionUpdate(att[1]!, att[2] as "done" | "snoozed");
        await this.api("answerCallbackQuery", { callback_query_id: q.id, text: item ? att[2] : "not found" }).catch(() => undefined);
        if (item && q.message) await this.api("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `${att[2] === "done" ? "✔ Done" : "💤 Snoozed 3 days"} · ${item.title}` }).catch(() => undefined);
        return;
      }
      const m = q.data?.match(/^apr:([^:]+):(approved|rejected)$/);
      if (m) {
        const a = await this.jarvis.decide(m[1]!, m[2] as "approved" | "rejected", "via Telegram");
        await this.api("answerCallbackQuery", { callback_query_id: q.id, text: a ? `${m[2]}` : "not found" }).catch(() => undefined);
        if (a && q.message) await this.api("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `${m[2] === "approved" ? "✅ Approved" : "❌ Rejected"} · ${a.title}${a.note ? `\n${a.note}` : ""}` }).catch(() => undefined);
      }
      return;
    }
    const msg = u.message;
    if (!msg) return;
    const imageFile = msg.photo?.length ? msg.photo[msg.photo.length - 1]!.file_id : msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : undefined;
    // Anything with speech in it is a voice note: Telegram's own, a round video note, an audio track, or a recording
    // forwarded from another app (which arrives as a document with an audio type).
    const audioDoc = msg.document?.mime_type?.startsWith("audio/") ? msg.document : undefined;
    const voice = msg.voice ?? msg.audio ?? msg.video_note ?? audioDoc;
    const doc = !imageFile && !audioDoc && msg.document ? msg.document : undefined;
    const other = msg.sticker ? "sticker" : msg.video ? "video" : msg.animation ? "GIF" : msg.location ? "location" : msg.contact ? "contact card" : msg.poll ? "poll" : undefined;
    if (!msg.text && !imageFile && !doc && !voice && !other) return;
    if (String(msg.chat.id) !== this.opts.chatId) { await this.api("sendMessage", { chat_id: msg.chat.id, text: "This is Phil's Jarvis. Not for you." }).catch(() => undefined); return; }
    if (!msg.text && !imageFile && !doc && !voice) {
      // Said plainly, rather than dropped: Phil once sent a voice memo and heard nothing back.
      await this.send(`I can't read a ${other} yet. Send it as text, a voice note, a photo or a file.`);
      return;
    }
    if (voice) {
      // A voice note: transcribed, shown back so Phil can see what was heard, then handled like a typed message.
      if (!transcriptionProvider() && !this.opts.transcribe) { await this.send("I can't hear voice notes yet: the server needs a transcription key (ElevenLabs, OpenAI or Groq). Type it for now."); return; }
      try {
        const { data } = await this.download(voice.file_id);
        const heard = await (this.opts.transcribe ?? transcribeDefault)(data, voice.mime_type ?? (msg.video_note ? "video/mp4" : "audio/ogg"));
        if (!heard) { await this.send("I couldn't make out that voice note."); return; }
        await this.send(`Heard: "${heard}"`);
        const text = msg.caption ? `${heard}\n\n${msg.caption}` : heard;
        const r = await this.jarvis.submit(text, { channel: "telegram", voice: true });
        if (r.message?.id && (await this.jarvis.store.settings.get("telegram.voiceReplies", false))) this.voiceAsked.add(r.message.id);
      } catch (e) { await this.send(`I couldn't take that voice note: ${(e as Error).message}`); }
      return;
    }
    if (doc) {
      // A spreadsheet is this week's ProEdge sales data for Stevon's deck; a PowerPoint is the deck template.
      const name = doc.file_name ?? "upload";
      try {
        const { data } = await this.download(doc.file_id);
        if (/\.pptx$/i.test(name)) {
          const t = await setTemplate(this.jarvis.store, "proedge", name, data);
          await this.send(`Got the template "${name}" (${t.outline.length} slides). Stevon's decks will follow its order, colours and fonts.`);
        } else {
          const f = await addDataFile(this.jarvis.store, "proedge", { name, mime: doc.mime_type, data, note: msg.caption });
          await this.send(`Saved ${name}${f.rows ? ` (${f.rows} rows)` : ""} as this week's ProEdge sales data. Stevon builds Tuesday's deck from it Monday at 8 pm; say "@stevon make the deck now" to get it sooner.`);
        }
      } catch (e) { await this.send(`I couldn't take ${name}: ${(e as Error).message}`); }
      return;
    }
    if (imageFile) {
      // A photo (with or without a caption) goes to Jarvis with the picture attached.
      try {
        const id = await this.downloadImage(imageFile);
        await this.jarvis.submit(msg.caption ?? "", { channel: "telegram", images: [id] });
      } catch (e) { await this.send(`I couldn't take that image: ${(e as Error).message}`); }
      return;
    }
    const text = msg.text!.trim();
    if (text === "/start") { await this.send("Jarvis here. Talk to me, @ an agent, or /help."); return; }
    // Spoken replies to voice notes are off unless Phil asks; /voice on|off switches them.
    const vm = text.match(/^\/voice(?:\s+(on|off))?$/i);
    if (vm) {
      if (vm[1]) await this.jarvis.store.settings.set("telegram.voiceReplies", vm[1].toLowerCase() === "on");
      const on = await this.jarvis.store.settings.get("telegram.voiceReplies", false);
      await this.send(on ? "Spoken replies are on: a voice note gets Jarvis's answer as audio too. /voice off to stop." : "Spoken replies are off: voice notes get text answers. /voice on to hear them.");
      return;
    }
    // Replies (ack, late reports, final) are forwarded as they land by the chat.message listener in start().
    await this.jarvis.submit(text, { channel: "telegram" });
  }
}

export interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string; caption?: string; photo?: { file_id: string; width: number; height: number; file_size?: number }[]; document?: { file_id: string; mime_type?: string; file_size?: number; file_name?: string }; voice?: { file_id: string; mime_type?: string; duration?: number; file_size?: number }; audio?: { file_id: string; mime_type?: string; duration?: number; file_size?: number }; video_note?: { file_id: string; mime_type?: string; duration?: number; file_size?: number }; sticker?: { file_id: string; emoji?: string }; video?: { file_id: string }; animation?: { file_id: string }; location?: { latitude: number; longitude: number }; contact?: { phone_number: string }; poll?: { id: string } };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } };
}
