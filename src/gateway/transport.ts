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

const v4 = (h: string) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h.replace(/:\d+$/, "")); return m ? m.slice(1).map(Number) : null; };
const privV4 = (o: number[]) => o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);

/**
 * Compare this phone's IPv4 address with the computer's direct addresses. Home networks are /24,
 * so a different first three octets almost always means a different network (guest Wi-Fi,
 * mobile data, a repeater with its own subnet). Returns a sentence, or "" when it looks fine.
 */
export function networkMismatch(localIp: string | undefined, directUrls: string[]): string {
  const me = localIp ? v4(localIp) : null;
  if (!me) return "";
  const hosts = directUrls.map((u) => v4(hostOf(u))).filter((o): o is number[] => !!o && privV4(o));
  if (!hosts.length) return "";
  if (!privV4(me)) return `This phone (${localIp}) is not on a local Wi-Fi network (mobile data or VPN?), so it can't reach the computer at ${hosts.map((o) => o.join(".")).join(", ")}. Join the same Wi-Fi as the computer, or use a relay.`;
  const same = hosts.some((o) => o[0] === me[0] && o[1] === me[1] && o[2] === me[2]);
  if (same) return "";
  return `This phone (${localIp}) appears to be on a different network than the computer (${hosts.map((o) => o.join(".")).join(", ")}). Connect the phone to the same Wi-Fi as the computer (not a guest network or a different router), or use a relay.`;
}

/** Readable explanation of why no route worked, naming each address. */
export function explainFailure(attempts: Attempt[], port?: string, localIp?: string): string {
  const mismatch = networkMismatch(localIp, attempts.filter((a) => a.route === "direct").map((a) => a.url));
  const lines = attempts.map((a) => `• ${a.route === "relay" ? "Relay" : "Direct"} ${hostOf(a.url)}: ${a.reason}`);
  const p = port ?? (attempts.find((a) => a.route === "direct") ? new URL(attempts.find((a) => a.route === "direct")!.url).port || "80" : "");
  const tips: string[] = [];
  const relayed = attempts.some((a) => a.route === "relay");
  if (mismatch) tips.push(mismatch);
  if (attempts.some((a) => a.route === "direct")) {
    if (!mismatch) tips.push("Make sure this phone is on the same Wi-Fi as the computer (not mobile data or a guest network).");
    // Public mode (a relay route exists) only connects outward, so never ask about the firewall there.
    if (p && !relayed) tips.push(`Allow TCP port ${p} in the computer's firewall (Settings → Devices on the computer shows the exact command).`);
    const d = attempts.find((a) => a.route === "direct" && isPrivateHost(a.url));
    if (d) tips.push(`Test it: open http://${hostOf(d.url)}/ in this phone's browser. If it doesn't load, the network${relayed ? "" : " or firewall"} is blocking it.`);
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
  /** This device's own IPv4 address, if known, to spot "different network" failures. */
  localIp?: string;
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

  /**
   * The desktop moves to another port (2420..2430) when its port is taken. If every saved direct
   * address failed, probe those ports on the same hosts in parallel and return the first that opens.
   */
  /** Set false to skip the port probe (tests). */
  probe = true;
  private probePorts(tried: string[]): Promise<string | null> {
    if (!this.probe) return Promise.resolve(null);
    const directs = tried.filter((u, i) => this.routeOf(this.urls.indexOf(u)) === "direct" && i >= 0);
    const cands: string[] = [];
    for (const d of directs) {
      let u: URL;
      try { u = new URL(d); } catch { continue; }
      for (let p = 2420; p <= 2430; p++) {
        const c = `${u.protocol}//${u.hostname}:${p}${u.pathname}`;
        if (!tried.includes(c) && !cands.includes(c)) cands.push(c);
      }
    }
    if (!cands.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      const socks: WebSocket[] = [];
      let left = cands.length, done = false;
      const finish = (u: string | null) => { if (done) return; done = true; clearTimeout(t); socks.forEach((w) => { try { w.close(); } catch { /* */ } }); resolve(u); };
      const t = setTimeout(() => finish(null), 2500);
      for (const c of cands) {
        let w: WebSocket;
        try { w = new this.Ctor(c); } catch { if (--left === 0) finish(null); continue; }
        socks.push(w);
        w.onopen = () => finish(c);
        let gone = false; // error and close both fire for one socket: count it once
        w.onerror = w.onclose = () => { if (gone) return; gone = true; if (--left === 0) finish(null); };
      }
    });
  }

  async open(): Promise<void> {
    this.attempts = [];
    let probed = false;
    for (let i = 0; i < this.urls.length; i++) {
      const route = this.routeOf(i);
      if (route === "relay" && !probed) {
        probed = true;
        const found = await this.probePorts(this.urls.slice(0, i));
        if (found) {
          try {
            await this.openOne(found, this.directTimeoutMs);
            this.route = "direct";
            this.connectedUrl = found;
            return;
          } catch (e) {
            this.attempts.push({ url: found, route: "direct", reason: String((e as Error)?.message ?? e) });
          }
        }
      }
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
          : quick ? "connection refused (gateway off, wrong port, or firewall rejecting)"
          : "no route to host (the phone couldn't find the computer on its network: different Wi-Fi, guest network or router client isolation; less often a firewall)";
        this.attempts.push({ url: this.urls[i], route, reason });
      }
    }
    if (!probed) {
      const found = await this.probePorts(this.urls);
      if (found) {
        await this.openOne(found, this.directTimeoutMs);
        this.route = "direct";
        this.connectedUrl = found;
        return;
      }
    }
    throw new Error(explainFailure(this.attempts, undefined, this.localIp));
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
