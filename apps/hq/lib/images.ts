"use client";

/**
 * Images Phil attaches: shrunk on his device first (longest side 1600 px, JPEG) so they upload fast and stay under
 * Claude's 5 MB limit, then uploaded; the server returns an id that goes with the message.
 */
export async function shrinkImage(file: Blob, max = 1600): Promise<Blob> {
  if (file.type === "image/gif") return file; // keep animation
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1_500_000 && file.type !== "image/heic") return file;
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b ?? file), "image/jpeg", 0.85));
}

export async function uploadImage(file: Blob): Promise<string> {
  const small = await shrinkImage(file);
  const r = await fetch("/api/uploads", { method: "POST", credentials: "include", headers: { "content-type": small.type || "image/jpeg" }, body: small });
  const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!r.ok || !j.id) throw new Error(j.error ?? `upload failed (${r.status})`);
  return j.id;
}

export const imageUrl = (id: string) => `/api/uploads/${encodeURIComponent(id)}`;
