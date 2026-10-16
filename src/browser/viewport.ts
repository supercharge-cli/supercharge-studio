/** Computer mode: a fixed desktop-size viewport shown scaled to fit the window. */
export type Size = { width: number; height: number };
export const PRESETS: Size[] = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1366, height: 768 }];
export const MIN_VP = 320, MAX_VP = 7680;

/** "1600x900", "1600 × 900" → size, or null. */
export function parseSize(s: string): Size | null {
  const m = /^\s*(\d{3,4})\s*[x×*,]\s*(\d{3,4})\s*$/i.exec(s);
  if (!m) return null;
  const width = +m[1], height = +m[2];
  return width >= MIN_VP && height >= MIN_VP / 2 && width <= MAX_VP && height <= MAX_VP ? { width, height } : null;
}

/** Scale (never above 1) and centered placement of `vp` inside `area` with `pad` px around. */
export function fitViewport(vp: Size, area: { x: number; y: number; width: number; height: number }, pad = 16) {
  const aw = Math.max(1, area.width - 2 * pad), ah = Math.max(1, area.height - 2 * pad);
  const scale = Math.min(1, aw / vp.width, ah / vp.height);
  const width = Math.round(vp.width * scale), height = Math.round(vp.height * scale);
  return { scale, width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) };
}

/** CSS px of the page per pixel of a screenshot `imgWidth` wide of a viewport `cssWidth` wide. */
export const cssPerPx = (cssWidth: number, imgWidth: number) => (imgWidth > 0 ? Math.round((cssWidth / imgWidth) * 1000) / 1000 : 1);

/** Crop rectangle in image pixels for an element box in CSS px (clamped to the image). */
export function cropRect(box: { x: number; y: number; width: number; height: number }, cssWidth: number, img: Size, pad = 8) {
  const k = img.width / Math.max(1, cssWidth);
  const x = Math.max(0, Math.floor((box.x - pad) * k)), y = Math.max(0, Math.floor((box.y - pad) * k));
  const w = Math.min(img.width - x, Math.ceil((box.width + 2 * pad) * k)), h = Math.min(img.height - y, Math.ceil((box.height + 2 * pad) * k));
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}
