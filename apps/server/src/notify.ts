/**
 * Push to Phil's phone. Two channels, either or both:
 *   NOTIFY_WEBHOOK_URL   an ntfy topic (https://ntfy.sh/<topic>) or any endpoint taking a POST with a "Title" header
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   a Telegram bot that messages Phil
 */
export async function notify(title: string, body: string) {
  const jobs: Promise<unknown>[] = [];
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (url) jobs.push(fetch(url, { method: "POST", headers: { Title: title, "content-type": "text/plain" }, body }));
  const tg = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tg && chat) {
    jobs.push(fetch(`https://api.telegram.org/bot${tg}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: `${title}\n${body}` }) }));
  }
  await Promise.all(jobs.map((j) => j.catch((e) => console.warn("notify failed:", (e as Error).message))));
}
