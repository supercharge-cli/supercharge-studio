import { b64, deviceKey, parsePairUri } from "../gateway/crypto";
import type { DeviceCreds } from "../gateway/transport";

const KEY = "supercharge-studio-mobile/creds/v1";

export function loadCreds(): DeviceCreds | null {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return j ? { ...j, key: b64.dec(j.key) } : null;
  } catch {
    return null;
  }
}
export function saveCreds(c: DeviceCreds | null) {
  if (!c) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify({ ...c, key: b64.enc(c.key) }));
}

/** Turn a scanned/pasted pairing code into first-connection credentials (id = pairing id). */
export async function pendingCredsFromCode(code: string, name: string): Promise<DeviceCreds> {
  const p = parsePairUri(code);
  return { url: p.url, deviceId: p.pairingId, key: await deviceKey(p.secret), name, desktopName: p.desktopName, relay: p.relay, ...(p.alts ? { alts: p.alts } : {}) };
}

export const defaultDeviceName = () => {
  const ua = navigator.userAgent;
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  return m ? m[1].replace(/ Build.*/, "").trim() : /iPhone|iPad/.test(ua) ? "iPhone" : "Phone";
};
