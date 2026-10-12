/**
 * Gateway crypto (client side, WebCrypto). Mirrors src-tauri/src/gateway.rs:
 * K = HMAC(pairSecret, "supercharge-gw/device-key"); sk = HMAC(K, "supercharge-gw/session" | nc | ns);
 * frames = counter(8, BE) | AES-256-GCM(sk, nonce = dir(4, BE) | counter(8, BE)).
 */
const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export const b64 = {
  enc: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  decUrl: (s: string) => b64.dec(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)),
};
export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

const cat = (parts: (Uint8Array | string)[]) => {
  const bs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const out = new Uint8Array(bs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const b of bs) { out.set(b, o); o += b.length; }
  return out;
};

export async function hmac(key: Uint8Array, ...parts: (Uint8Array | string)[]): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, cat(parts) as BufferSource));
}
export const deviceKey = (pairSecret: Uint8Array) => hmac(pairSecret, "supercharge-gw/device-key");
export const sessionKey = (k: Uint8Array, nc: Uint8Array, ns: Uint8Array) => hmac(k, "supercharge-gw/session", nc, ns);

function nonce(dir: number, ctr: bigint) {
  const n = new Uint8Array(12);
  const v = new DataView(n.buffer);
  v.setUint32(0, dir);
  v.setBigUint64(4, ctr);
  return n;
}

export class Channel {
  private sendCtr = 0n;
  private recvCtr = 0n;
  private constructor(private key: CryptoKey, private sendDir: number) {}
  static async create(sk: Uint8Array, server = false) {
    const key = await subtle().importKey("raw", sk as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
    return new Channel(key, server ? 2 : 1);
  }
  async seal(plain: string): Promise<Uint8Array> {
    const ctr = ++this.sendCtr;
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce(this.sendDir, ctr) as BufferSource }, this.key, enc.encode(plain) as BufferSource));
    const out = new Uint8Array(8 + ct.length);
    new DataView(out.buffer).setBigUint64(0, ctr);
    out.set(ct, 8);
    return out;
  }
  async open(frame: Uint8Array): Promise<string> {
    if (frame.length < 24) throw new Error("short frame");
    const ctr = new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0);
    if (ctr <= this.recvCtr) throw new Error("replayed frame");
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: nonce(3 - this.sendDir, ctr) as BufferSource }, this.key, frame.subarray(8) as BufferSource);
    this.recvCtr = ctr;
    return new TextDecoder().decode(pt);
  }
}

export type PairInfo = { url: string; pairingId: string; secret: Uint8Array; desktopName: string; relay?: string };
export const PAIR_ERROR = "That QR code isn't a Supercharge Studio pairing code. Open Settings → Devices → Show pairing code on your computer and scan that.";

/**
 * Parse a scanned or pasted pairing code. Never throws anything but an Error with a
 * readable message, whatever the input (other QR codes, truncated scans, binary junk).
 */
export function parsePairUri(input: unknown): PairInfo {
  const fail = (msg = PAIR_ERROR): never => { throw new Error(msg); };
  if (typeof input !== "string") fail();
  let raw = (input as string).replace(/[\s\u0000-\u001f\u200b-\u200d\ufeff]+/g, "");
  if (!raw || raw.length > 4096) fail();
  // A link that was URL-encoded once more (some scanners and chat apps do this).
  if (/^(scstudio|supercharge-studio)%3A/i.test(raw)) { try { raw = decodeURIComponent(raw); } catch { fail(); } }
  // The link may be embedded in other text, e.g. "Pair: scstudio://pair?…".
  const m = raw.match(/(?:scstudio|supercharge-studio):\/\/pair\/?\?[^\s"'<>]*/i);
  if (!m) fail();
  let q: URLSearchParams;
  try { q = new URL(m![0].replace(/^(scstudio|supercharge-studio):\/\/pair\/?/i, "https://x/pair")).searchParams; } catch { return fail(); }
  const url = q.get("u"), id = q.get("i"), k = q.get("k");
  if (!url || !id || !k) fail();
  if (!/^wss?:\/\/[^\s/]+/i.test(url!)) fail("This pairing code has an invalid address. Show a new code on your computer and scan again.");
  try { new URL(url!); } catch { fail("This pairing code has an invalid address. Show a new code on your computer and scan again."); }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id!)) fail();
  let secret: Uint8Array = new Uint8Array();
  try { if (!/^[A-Za-z0-9_\-+/=]+$/.test(k!)) throw 0; secret = b64.decUrl(k!.replace(/=+$/, "")); } catch { fail("This pairing code is damaged. Show a new code on your computer and scan again."); }
  if (secret.length !== 32) fail("This pairing code is damaged. Show a new code on your computer and scan again.");
  const relay = q.get("r") || undefined;
  if (relay) { let ok = /^wss?:\/\//i.test(relay); try { new URL(relay); } catch { ok = false; } if (!ok) fail("This pairing code has an invalid relay address."); }
  const desktopName = (q.get("n") || "Desktop").slice(0, 80);
  return { url: url!, pairingId: id!, secret, desktopName, relay };
}
