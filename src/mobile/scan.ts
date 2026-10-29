/**
 * QR scanning and pairing links via the native barcode and deep-link plugins, talking to their IPC
 * directly (the plugins' JS wrappers stay out of the bundle). Only the lazy pairing screen imports this.
 */
import { invoke, isDesktop } from "../lib/desktop";
export const canScan = isDesktop;

const BS = "plugin:barcode-scanner|";
type Perm = "granted" | "denied" | "prompt" | "prompt-with-rationale";
const perm = (cmd: string) => invoke<{ camera?: Perm }>(BS + cmd).then((r) => r?.camera, () => undefined);

/** Pull the text out of whatever the native scanner returned; null for anything unusable. */
export function scanContent(r: unknown): string | null {
  if (!r || typeof r !== "object") return typeof r === "string" && r.trim() ? r : null;
  const c = (r as { content?: unknown }).content;
  return typeof c === "string" && c.trim() ? c : null;
}

/** True when the browser layer can list devices and none of them is a camera (the native scan would never start). */
async function noCamera(): Promise<boolean> {
  try {
    const d = await navigator.mediaDevices?.enumerateDevices?.();
    return !!d?.length && !d.some((x) => x.kind === "videoinput");
  } catch { return false; }
}

/** Get the camera ready: "ok", or why it can't scan. */
export async function cameraReady(): Promise<"ok" | "denied" | "nocam"> {
  if (await noCamera()) return "nocam";
  let p = await perm("check_permissions");
  if (p !== "granted") p = await perm("request_permissions");
  return p === "granted" ? "ok" : "denied";
}

/**
 * Show the live camera behind the (transparent) web view and resolve with the first QR code's text,
 * or null when cancelled. Rejects with the native error otherwise.
 */
export async function scanOnce(): Promise<string | null> {
  try {
    return scanContent(await invoke(BS + "scan", { windowed: true, formats: ["QR_CODE"] }));
  } catch (e: unknown) {
    // A read tears the camera view down natively; after a failure make sure it is gone too.
    void stopScan();
    if (/cancel/i.test(String((e as { message?: unknown })?.message ?? e))) return null;
    throw e;
  }
}

export const stopScan = () => invoke(BS + "cancel").catch(() => {});
export const openCameraSettings = () => invoke(BS + "open_app_settings").catch(() => {});
/** A short tick on a successful read, where the phone has a vibration motor. */
export const buzz = () => { try { navigator.vibrate?.(30) || void invoke(BS + "vibrate").catch(() => {}); } catch { /* no haptics */ } };

/** Pairing links opened from outside the app (supercharge-studio://pair?… or scstudio://pair?…). */
export async function onPairLink(cb: (uri: string) => void): Promise<void> {
  if (!isDesktop()) return;
  const pick = (urls: unknown) => {
    const u = Array.isArray(urls) ? urls.find((x) => typeof x === "string" && /^(supercharge-studio|scstudio):\/\/pair\/?\?/i.test(x)) : undefined;
    if (u) cb(u);
  };
  pick(await invoke("plugin:deep-link|get_current").catch(() => null));
  // Subscribe straight on the IPC (no unlisten needed: the pairing screen keeps it for its lifetime).
  const handler = (window as any).__TAURI_INTERNALS__.transformCallback((e: { payload: unknown }) => pick(e.payload));
  await invoke("plugin:event|listen", { event: "deep-link://new-url", target: { kind: "Any" }, handler });
}
