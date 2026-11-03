/**
 * Push to Phil's phone. Set NOTIFY_WEBHOOK_URL to an ntfy topic (https://ntfy.sh/<topic>) or any endpoint
 * that accepts a POST with a "Title" header and a text body. Telegram/web push can plug in here later.
 */
export async function notify(title: string, body: string) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, { method: "POST", headers: { Title: title, "content-type": "text/plain" }, body }).catch((e) => console.warn("notify failed:", (e as Error).message));
}
