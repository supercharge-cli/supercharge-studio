import type { Transport } from "../acp/transport";
import { b64, Channel, hmac, random, sessionKey } from "./crypto";

/** Credentials a device keeps after pairing. The key never leaves the device. */
export type DeviceCreds = { url: string; deviceId: string; key: Uint8Array; name: string; desktopName?: string };

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

  constructor(private url: string, private id: string, private key: Uint8Array, private name: string, private Ctor: WsCtor = globalThis.WebSocket as WsCtor, private onStage?: (s: string) => void) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.Ctor(this.url);
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
