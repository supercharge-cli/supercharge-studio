/** Client-side downscale for pasted / dropped / picked images so prompts stay small. */
export const MAX_DIM = 2000;
export const QUALITY = 0.85;
/** Images under this size and within MAX_DIM are sent as-is. */
export const KEEP_BYTES = 1.5 * 1024 * 1024;

/** Target size that fits in max×max, keeping aspect ratio; never upscales. */
export function fitSize(w: number, h: number, max = MAX_DIM): { w: number; h: number; scaled: boolean } {
  if (!(w > 0 && h > 0)) return { w: 0, h: 0, scaled: false };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: k < 1 };
}

/** Whether an image should be re-encoded (too big in pixels or bytes; GIFs keep their animation). */
export function needsResize(mime: string, w: number, h: number, bytes: number, max = MAX_DIM): boolean {
  if (/gif/i.test(mime)) return false;
  return Math.max(w, h) > max || bytes > KEEP_BYTES;
}

/** Output type: keep PNG-with-transparency as WebP, photos as JPEG. */
export const outputType = (mime: string) => (/png|webp/i.test(mime) ? "image/webp" : "image/jpeg");

/** Downscale in the browser. Returns the original file when not needed or not possible. */
export async function downscaleImage(f: File, max = MAX_DIM): Promise<File> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return f;
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(f); } catch { return f; }
  try {
    if (!needsResize(f.type, bmp.width, bmp.height, f.size, max)) return f;
    const t = fitSize(bmp.width, bmp.height, max);
    const c = document.createElement("canvas");
    c.width = t.w; c.height = t.h;
    const g = c.getContext("2d");
    if (!g) return f;
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, 0, 0, t.w, t.h);
    let type = outputType(f.type);
    let blob = await new Promise<Blob | null>((r) => c.toBlob(r, type, QUALITY));
    if (!blob || blob.type !== type) { type = "image/jpeg"; blob = await new Promise<Blob | null>((r) => c.toBlob(r, type, QUALITY)); }
    if (!blob || blob.size >= f.size) return f;
    const base = (f.name || "pasted-image").replace(/\.[^.]+$/, "");
    return new File([blob], `${base}.${type === "image/webp" ? "webp" : "jpg"}`, { type });
  } finally { bmp.close?.(); }
}
