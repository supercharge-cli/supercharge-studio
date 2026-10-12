import type { Transport } from "../acp/transport";
import { b64, Channel, hmac, random, sessionKey } from "./crypto";

/** Credentials a device keeps after pairing. The key never leaves the device. */
export type DeviceCreds = { url: string; deviceId: string; key: Uint8Array; name: string; desktopName?: string; relay?: string };

/**
 * Where to reach the desktop, in order: the direct (LAN/tunnel) URL, then the optional
 * relay. The relay only forwards opaque frames; the handshake and AES-GCM channel are
 * end-to-end between this device and the desktop, exactly as on the LAN.
 */
export const candidates = (c: Pick<DeviceCreds, "url" | "relay">) => [c.url, ...(c.relay && c.relay !== c.url ? [c.relay] : [])];

type WsCtor = new (url: string) => WebSocket;

/**
 * Authenticated, encrypted transport to the desktop gateway. Plug into AcpClient
 * via `transportFactory`. `id` is a device id, or a one-time pairing id while pairing.
 */
export class GatewayTransport implements Transport {
  private ws: WebSocket | null = null;
  private ch: Channel | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  onMessage: (data: string) => void = () => {};
  onClose: (reason?: string) => void = () => {};
  /** Device id assigned by the desktop (set after a successful handshake). */
  deviceId = "";
  /** The URL that connected ("direct" or "relay" route). */
  route: "direct" | "relay" = "direct";
  private urls: string[];

  constructor(url: string | string[], private id: string, private key: Uint8Array, private name: string, private Ctor: WsCtor = globalThis.WebSocket as WsCtor, private onStage?: (s: string) => void, private directTimeoutMs = 2500) {
    this.urls = Array.isArray(url) ? url : [url];
  }

  async open(): Promise<void> {
    let last: unknown;
    for (let i = 0; i < this.urls.length; i++) {
      try {
        await this.openOne(this.urls[i], i < this.urls.length - 1 ? this.directTimeoutMs : 0);
        this.route = i === 0 ? "direct" : "relay";
        return;
      } catch (e) {
        last = e;
        // Auth failures are final; only unreachable routes fall through to the next one.
        if (!/reach|closed|timed out/i.test(String((e as Error)?.message))) throw e;
      }
    }
    throw last;
  }

  private openOne(url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.Ctor(url);
      const timer = timeoutMs ? setTimeout(() => { if (!ready) { reject(new Error("Gateway timed out")); ws.close(); } }, timeoutMs) : 0;
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      const nc = random(16);
      let ready = false;
      let sk: Uint8Array | null = null;
      let ns: Uint8Array | null = null;
      const fail = (e: string) => { if (!ready) reject(new Error(e)); ws.close(); };
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", id: this.id, nc: b64.enc(nc), name: this.name }));
      ws.onerror = () => fail("Cannot reach the desktop gateway");
      ws.onclose = (ev) => { if (!ready) reject(new Error(`Gateway closed (${ev.code})`)); else this.onClose(ev.reason || String(ev.code)); };
      ws.onmessage = (ev) => {
        const p = (async () => {
          if (ready && typeof ev.data !== "string") {
            this.onMessage(await this.ch!.open(new Uint8Array(ev.data as ArrayBuffer)));
            return;
          }
          const m = JSON.parse(String(ev.data));
          if (m.t === "challenge") {
            if (timer) clearTimeout(timer); // route is live; pairing approval may take a while
            ns = b64.dec(m.ns);
            sk = await sessionKey(this.key, nc, ns);
            this.onStage?.("waiting");
            ws.send(JSON.stringify({ t: "auth", mac: b64.enc(await hmac(sk, "client", nc, ns)) }));
          } else if (m.t === "ok" && sk && ns) {
            const expect = b64.enc(await hmac(sk, "server", nc, ns));
            if (m.mac !== expect) return fail("Desktop failed to authenticate");
            this.ch = await Channel.create(sk);
            this.deviceId = m.deviceId;
            ready = true;
            if (timer) clearTimeout(timer);
            resolve();
          } else if (m.t === "denied") fail(m.reason ?? "Denied");
        })();
        this.chain = this.chain.then(() => p).catch((e) => fail(String(e?.message ?? e)));
      };
    });
  }

  send(data: string) {
    if (!this.ws || !this.ch) throw new Error("Not connected");
    const ws = this.ws, ch = this.ch;
    this.chain = this.chain.then(async () => ws.send(await ch.seal(data)));
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
