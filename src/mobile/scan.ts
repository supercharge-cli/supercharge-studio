/** QR scanning via the native barcode plugin when running as a mobile app. */
export const canScan = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let scanning = false;

/** Pull the text out of whatever the native scanner returned; null for anything unusable. */
export function scanContent(r: unknown): string | null {
  if (!r || typeof r !== "object") return typeof r === "string" && r.trim() ? r : null;
  const c = (r as { content?: unknown }).content;
  return typeof c === "string" && c.trim() ? c : null;
}

/**
 * Scan one QR code. Resolves with its text, or null when cancelled; rejects only with a
 * readable Error. Guards against double taps, and always shuts the camera view down.
 */
export async function scanQr(): Promise<string | null> {
  if (!canScan() || scanning) return null;
  scanning = true;
  let mod: typeof import("@tauri-apps/plugin-barcode-scanner") | null = null;
  try {
    mod = await import("@tauri-apps/plugin-barcode-scanner");
    let perm = await mod.checkPermissions().catch(() => "prompt" as const);
    if (perm !== "granted") perm = await mod.requestPermissions().catch(() => "denied" as const);
    if (perm !== "granted") throw new Error("Camera permission is needed to scan the pairing code. Allow it in Android Settings, or paste the code instead.");
    const r = await mod.scan({ windowed: false, formats: [mod.Format.QRCode] });
    const text = scanContent(r);
    // Let the native camera view finish tearing down before the UI reacts to the result.
    await new Promise((res) => setTimeout(res, 250));
    return text;
  } catch (e: unknown) {
    try { await mod?.cancel(); } catch { /* already closed */ }
    const msg = String((e as { message?: unknown })?.message ?? e ?? "");
    if (/cancel/i.test(msg)) return null;
    throw new Error(msg.startsWith("Camera permission") ? msg : `Couldn't scan the code${msg ? ` (${msg})` : ""}. You can paste the pairing code instead.`);
  } finally {
    scanning = false;
  }
}

/** Pairing links opened from outside the app (supercharge-studio://pair?… or scstudio://pair?…). */
export async function onPairLink(cb: (uri: string) => void): Promise<void> {
  if (!canScan()) return;
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const pick = (urls: unknown) => {
    try {
      const u = Array.isArray(urls) ? urls.find((x) => typeof x === "string" && /^(supercharge-studio|scstudio):\/\/pair\/?\?/i.test(x)) : undefined;
      if (u) cb(u);
    } catch { /* ignore malformed links */ }
  };
  pick(await getCurrent().catch(() => null));
  await onOpenUrl(pick);
}
