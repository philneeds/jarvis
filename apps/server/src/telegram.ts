import { bus, getAgent, type Approval, type Jarvis, type JarvisEvent, saveImage } from "@jarvis/core";

/**
 * Two-way Telegram: Phil talks to Jarvis from his phone, and approvals arrive with Approve / Reject buttons.
 *   TELEGRAM_BOT_TOKEN   from @BotFather
 *   TELEGRAM_CHAT_ID     Phil's chat id; every other sender is ignored
 * Long polling, no public webhook needed.
 */
export interface TelegramOptions { token: string; chatId: string; fetch?: typeof fetch; pollTimeout?: number }

export class TelegramBot {
  private f: typeof fetch;
  private offset = 0;
  private running = false;
  private off?: () => void;
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

  start() {
    this.running = true;
    this.off = bus.onEvent((e: JarvisEvent) => {
      if (e.type === "chat.message" && e.message.channel === "telegram" && e.message.role !== "phil") {
        const o = e.message;
        const who = o.role === "jarvis" ? "Jarvis" : o.role === "system" ? "HQ" : getAgent(o.agentId ?? "")?.name ?? o.agentId ?? "Agent";
        void this.send(`${who}: ${o.text}`);
      }
      if (e.type === "report") void this.send(`${e.title} · ${e.agentId === "jarvis" ? "Jarvis" : getAgent(e.agentId)?.name ?? e.agentId}\n\n${e.text}`);
      if (e.type === "approval.new") void this.announce(e.approval);
      if (e.type === "attention" && e.change === "raised") void this.send(`Needs you · ${getAgent(e.item.agentId)?.name ?? e.item.agentId}\n${e.item.title}\n\n${e.item.why.slice(0, 800)}${e.item.due ? `\nDue ${e.item.due}` : ""}`, { reply_markup: { inline_keyboard: [[{ text: "✔ Done", callback_data: `att:${e.item.id}:done` }, { text: "💤 Snooze 3d", callback_data: `att:${e.item.id}:snoozed` }]] } });
    });
    void this.loop();
  }
  stop() { this.running = false; this.off?.(); }

  /** Fetch a photo Phil sent and keep it as an upload. */
  private async downloadImage(fileId: string): Promise<string> {
    const r = (await (await this.api("getFile", { file_id: fileId })).json()) as { ok: boolean; result?: { file_path?: string; file_size?: number } };
    const fp = r.result?.file_path;
    if (!r.ok || !fp) throw new Error("Telegram didn't give me the file");
    const res = await this.f(`https://api.telegram.org/file/bot${this.opts.token}/${fp}`);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const ext = fp.split(".").pop()?.toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
    return saveImage(Buffer.from(await res.arrayBuffer()), mime);
  }

  private async announce(a: Approval) {
    const who = getAgent(a.agentId)?.name ?? a.agentId;
    await this.send(`Approval · ${who} · ${a.kind}\n${a.title}\n\n${a.body.slice(0, 1500)}${a.context ? `\n\nContext: ${a.context.slice(0, 800)}` : ""}${a.effect ? `\n\nIf you approve: ${a.effect}` : ""}\n\nTo ask ${who} about it or edit the text, open Approvals in HQ.`, {
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
    if (!msg.text && !imageFile) return;
    if (String(msg.chat.id) !== this.opts.chatId) { await this.api("sendMessage", { chat_id: msg.chat.id, text: "This is Phil's Jarvis. Not for you." }).catch(() => undefined); return; }
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
    // Replies (ack, late reports, final) are forwarded as they land by the chat.message listener in start().
    await this.jarvis.submit(text, { channel: "telegram" });
  }
}

export interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string; caption?: string; photo?: { file_id: string; width: number; height: number; file_size?: number }[]; document?: { file_id: string; mime_type?: string; file_size?: number } };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } };
}
