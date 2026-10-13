import type { Transport } from "../acp/transport";
import { b64, Channel, hmac, random, sessionKey } from "./crypto";

/** Credentials a device keeps after pairing. The key never leaves the device. */
export type DeviceCreds = { url: string; deviceId: string; key: Uint8Array; name: string; desktopName?: string; relay?: string; alts?: string[] };

/**
 * Where to reach the desktop, in order: the direct (LAN/tunnel) URL, then the optional
 * relay. The relay only forwards opaque frames; the handshake and AES-GCM channel are
 * end-to-end between this device and the desktop, exactly as on the LAN.
 */
export const candidates = (c: Pick<DeviceCreds, "url" | "relay" | "alts">) => {
  const out: string[] = [];
  for (const u of [c.url, ...(c.alts ?? []), ...(c.relay ? [c.relay] : [])]) if (u && !out.includes(u)) out.push(u);
  return out;
};

/** One failed attempt, for diagnostics shown to the user. */
export type Attempt = { url: string; route: "direct" | "relay"; reason: string };

const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
const isPrivateHost = (u: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(hostOf(u));

/** Readable explanation of why no route worked, naming each address. */
export function explainFailure(attempts: Attempt[], port?: string): string {
  const lines = attempts.map((a) => `• ${a.route === "relay" ? "Relay" : "Direct"} ${hostOf(a.url)}: ${a.reason}`);
  const p = port ?? (attempts.find((a) => a.route === "direct") ? new URL(attempts.find((a) => a.route === "direct")!.url).port || "80" : "");
  const tips: string[] = [];
  if (attempts.some((a) => a.route === "direct")) {
    tips.push("Make sure this phone is on the same Wi-Fi as the computer (not mobile data or a guest network).");
    if (p) tips.push(`Allow TCP port ${p} in the computer's firewall (Settings → Devices on the computer shows the exact command).`);
    const d = attempts.find((a) => a.route === "direct" && isPrivateHost(a.url));
    if (d) tips.push(`Test it: open http://${hostOf(d.url)}/ in this phone's browser. If it doesn't load, the network or firewall is blocking it.`);
  }
  if (!attempts.some((a) => a.route === "relay")) tips.push("To connect from anywhere, set a relay URL in Settings → Devices on the computer, then show a new code.");
  return `Cannot reach the desktop gateway.\n${lines.join("\n")}\n${tips.join("\n")}`;
}

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
  /** The URL that completed the handshake. */
  connectedUrl = "";
  /** Failed attempts from the last open(). */
  attempts: Attempt[] = [];
  private urls: string[];
  private relayUrl?: string;

  constructor(url: string | string[], private id: string, private key: Uint8Array, private name: string, private Ctor: WsCtor = globalThis.WebSocket as WsCtor, private onStage?: (s: string) => void, private directTimeoutMs = 3500, relayUrl?: string) {
    this.urls = Array.isArray(url) ? url : [url];
    // By default the last of several candidates is the relay (see `candidates`); callers may say so explicitly.
    this.relayUrl = relayUrl;
  }

  private routeOf(i: number): "direct" | "relay" {
    const u = this.urls[i];
    if (this.relayUrl !== undefined) return u === this.relayUrl ? "relay" : "direct";
    return /\/v1\/connect\//.test(u) ? "relay" : "direct";
  }

  async open(): Promise<void> {
    this.attempts = [];
    for (let i = 0; i < this.urls.length; i++) {
      const route = this.routeOf(i);
      const started = Date.now();
      try {
        await this.openOne(this.urls[i], route === "relay" ? 12000 : this.directTimeoutMs);
        this.route = route;
        this.connectedUrl = this.urls[i];
        return;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // Auth failures are final; only unreachable routes fall through to the next one.
        if (!/reach|closed|timed out/i.test(msg)) throw e;
        const quick = Date.now() - started < 1500;
        const reason = /timed out/i.test(msg) ? "no answer (blocked by a firewall, or a different network)"
          : /closed \((\d+)\)/i.test(msg) ? `connection closed (${msg.match(/closed \((\d+)\)/i)![1]})${route === "relay" ? ", is this computer online on the relay?" : ""}`
          : quick ? "connection refused (gateway off, wrong port, or firewall rejecting)" : "unreachable";
        this.attempts.push({ url: this.urls[i], route, reason });
      }
    }
    throw new Error(explainFailure(this.attempts));
  }

  private openOne(url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws0: WebSocket;
      try { ws0 = new this.Ctor(url); } catch { reject(new Error("Cannot reach the desktop gateway (bad address)")); return; }
      const ws = ws0;
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
