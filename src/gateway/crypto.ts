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

export type PairInfo = { url: string; pairingId: string; secret: Uint8Array; desktopName: string };
export function parsePairUri(uri: string): PairInfo {
  const q = new URL(uri.trim().replace(/^scstudio:\/\//, "https://x/"));
  const url = q.searchParams.get("u"), id = q.searchParams.get("i"), k = q.searchParams.get("k");
  if (!url || !id || !k) throw new Error("Not a Supercharge Studio pairing code");
  const secret = b64.decUrl(k);
  if (secret.length !== 32) throw new Error("Invalid pairing secret");
  return { url, pairingId: id, secret, desktopName: q.searchParams.get("n") ?? "Desktop" };
}
