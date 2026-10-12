/** QR scanning via the native barcode plugin when running as a mobile app. */
export const canScan = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function scanQr(): Promise<string | null> {
  if (!canScan()) return null;
  const { scan, Format, checkPermissions, requestPermissions } = await import("@tauri-apps/plugin-barcode-scanner");
  let perm = await checkPermissions();
  if (perm !== "granted") perm = await requestPermissions();
  if (perm !== "granted") throw new Error("Camera permission is needed to scan the pairing code");
  const r = await scan({ windowed: false, formats: [Format.QRCode] });
  return r?.content ?? null;
}

/** Pairing links opened from outside the app (supercharge-studio://pair?… or scstudio://pair?…). */
export async function onPairLink(cb: (uri: string) => void): Promise<void> {
  if (!canScan()) return;
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const pick = (urls: string[] | null) => { const u = urls?.find((x) => /^(supercharge-studio|scstudio):\/\/pair\?/.test(x)); if (u) cb(u); };
  pick(await getCurrent());
  await onOpenUrl(pick);
}
