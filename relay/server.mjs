import { pathToFileURL } from "node:url";
// Supercharge Studio relay (docs/RELAY.md). A blind pipe between phones and a host (desktop app
// or headless server) for when they are not on the same network. It never sees keys or
// plaintext: every lane carries the gateway's own handshake and AES-GCM frames, end to end.
//
//   /v1/host/<hostId>                    host control socket  {"t":"register","token"} -> {"t":"registered"}
//   /v1/connect/<hostId>                 phone                relay -> host {"t":"lane","lane"}
//   /v1/lane/<hostId>/<lane>?token=...   host attaches; frames are piped verbatim
//   GET /healthz (liveness + counters), GET /readyz, GET /v1/stats (optionally token protected)
//
// Configuration is environment only, see docs/RELAY.md for the full table.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const num = (k, d) => { const v = Number(env(k, d)); return Number.isFinite(v) && v >= 0 ? v : d; };
export const config = () => ({
  port: num("PORT", 8080),
  host: env("HOST", "0.0.0.0"),
  data: env("RELAY_DATA", ""),
  maxFrame: num("RELAY_MAX_FRAME", 256 * 1024),
  maxHosts: num("RELAY_MAX_HOSTS", 5000),
  maxConns: num("RELAY_MAX_CONNS", 20000),
  maxConnsPerIp: num("RELAY_MAX_CONNS_PER_IP", 64),
  connRatePerIp: num("RELAY_CONN_RATE_PER_MIN", 120),
  maxLanes: num("RELAY_MAX_LANES_PER_HOST", 8),
  laneBps: num("RELAY_LANE_BYTES_PER_SEC", 2 * 1024 * 1024),
  idleMs: num("RELAY_IDLE_SECS", 120) * 1000,
  pendingMs: num("RELAY_ATTACH_SECS", 10) * 1000,
  pingMs: num("RELAY_PING_SECS", 30) * 1000,
  bindingTtlMs: num("RELAY_BINDING_TTL_DAYS", 90) * 86400_000,
  maxBindings: num("RELAY_MAX_BINDINGS", 100000),
  trustProxy: env("RELAY_TRUST_PROXY", "0") === "1",
  statsToken: env("RELAY_STATS_TOKEN", ""),
  audit: env("RELAY_AUDIT", "0") === "1",
  quiet: env("RELAY_QUIET", "0") === "1",
});

const ID = /^[A-Za-z0-9-]{8,64}$/;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export function startRelay(port, host, overrides = {}) {
  const C = { ...config(), ...(port !== undefined ? { port } : {}), ...(host !== undefined ? { host } : {}), ...overrides };
  const log = (...a) => { if (!C.quiet) console.log(new Date().toISOString(), ...a); };
  const started = Date.now();
  /** hostId -> { h: sha256(token), seen: ms } (trust on first use; pruned after TTL). */
  const bindings = new Map();
  try {
    if (C.data && existsSync(C.data)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(C.data, "utf8")))) bindings.set(k, typeof v === "string" ? { h: v, seen: Date.now() } : v);
  } catch (e) { log("could not read bindings:", e.message); }
  let dirty = false;
  const persist = () => { dirty = true; };
  const flush = () => {
    if (!dirty || !C.data) return;
    dirty = false;
    try { writeFileSync(C.data + ".tmp", JSON.stringify(Object.fromEntries(bindings)), { mode: 0o600 }); renameSync(C.data + ".tmp", C.data); } catch (e) { log("could not save bindings:", e.message); }
  };
  const prune = () => {
    const now = Date.now();
    for (const [k, v] of bindings) if (!hosts.has(k) && now - (v.seen ?? 0) > C.bindingTtlMs) { bindings.delete(k); dirty = true; }
    if (bindings.size > C.maxBindings) {
      const old = [...bindings].filter(([k]) => !hosts.has(k)).sort((a, b) => a[1].seen - b[1].seen);
      for (const [k] of old.slice(0, bindings.size - C.maxBindings)) bindings.delete(k);
      dirty = true;
    }
  };
  const hosts = new Map(); // hostId -> { ws, lanes: Set }
  const pending = new Map(); // lane -> { hostId, client, queue, timer }
  const perIp = new Map(); // ip -> open sockets
  const rate = new Map(); // ip -> { n, reset }
  const stats = { hosts: 0, lanes: 0, lanesOpen: 0, frames: 0, bytes: 0, rejected: 0, throttled: 0, plaintextSeen: false };

  const audit = (data) => {
    stats.frames++;
    stats.bytes += data.length ?? 0;
    if (C.audit && Buffer.from(data).toString("latin1").includes('"jsonrpc"')) stats.plaintextSeen = true;
  };
  const ipOf = (req) => {
    const xf = C.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return xf || req.socket.remoteAddress || "?";
  };
  /** Token bucket per lane direction: pause the sender's socket when over budget (backpressure, no drops). */
  const throttle = (src) => {
    if (!C.laneBps) return () => {};
    let tokens = C.laneBps, last = Date.now();
    return (n) => {
      const now = Date.now();
      tokens = Math.min(C.laneBps, tokens + ((now - last) / 1000) * C.laneBps);
      last = now;
      tokens -= n;
      if (tokens < 0 && src._socket && !src._paused) {
        stats.throttled++;
        src._paused = true;
        src._socket.pause();
        setTimeout(() => { src._paused = false; src._socket?.resume(); }, Math.min(2000, (-tokens / C.laneBps) * 1000));
      }
    };
  };
  function pipe(a, b) {
    let idle;
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => { a.close(1000, "idle"); b.close(1000, "idle"); }, C.idleMs); };
    bump();
    const ta = throttle(a), tb = throttle(b);
    a.on("message", (d, bin) => { audit(d); bump(); ta(d.length ?? 0); if (b.readyState === 1) b.send(d, { binary: bin }); });
    b.on("message", (d, bin) => { audit(d); bump(); tb(d.length ?? 0); if (a.readyState === 1) a.send(d, { binary: bin }); });
    let ended = false;
    const end = () => { if (ended) return; ended = true; stats.lanesOpen--; clearTimeout(idle); a.close(); b.close(); };
    a.on("close", end);
    b.on("close", end);
  }

  const http = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("cache-control", "no-store");
    if (path === "/healthz" || path === "/readyz") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, uptime: Math.round((Date.now() - started) / 1000), hosts: hosts.size, lanes: stats.lanesOpen, conns: wss.clients.size }));
    }
    if (path === "/v1/stats") {
      if (C.statsToken && !eq(String(req.headers.authorization ?? ""), `Bearer ${C.statsToken}`)) { res.statusCode = 401; return res.end(); }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ...stats, hosts: hosts.size, bindings: bindings.size, conns: wss.clients.size }));
    }
    if (path === "/") { res.setHeader("content-type", "text/plain"); return res.end("Supercharge Studio relay. End-to-end encrypted; this server cannot read your sessions.\n"); }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: C.maxFrame, perMessageDeflate: false });
  http.on("upgrade", (req, sock, head) => {
    const ip = ipOf(req);
    const now = Date.now();
    const r = rate.get(ip) ?? { n: 0, reset: now + 60_000 };
    if (now > r.reset) { r.n = 0; r.reset = now + 60_000; }
    r.n++;
    rate.set(ip, r);
    const deny = (code, why) => { stats.rejected++; sock.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); sock.destroy(); };
    if (C.connRatePerIp && r.n > C.connRatePerIp) return deny(429, "Too Many Requests");
    if (C.maxConns && wss.clients.size >= C.maxConns) return deny(503, "Service Unavailable");
    if (C.maxConnsPerIp && (perIp.get(ip) ?? 0) >= C.maxConnsPerIp) return deny(429, "Too Many Requests");
    wss.handleUpgrade(req, sock, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      ws.on("close", () => { const n = (perIp.get(ip) ?? 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); });
      ws.on("error", () => {});
      onConnection(ws, req);
    });
  });

  function onConnection(ws, req) {
    const u = new URL(req.url ?? "/", "http://relay");
    const [, v1, kind, hostId, lane] = u.pathname.split("/");
    if (v1 !== "v1" || !ID.test(hostId ?? "")) return ws.close(4400, "bad path");
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    if (kind === "host") {
      const t = setTimeout(() => ws.close(4408, "register timeout"), 10_000);
      ws.once("message", (raw) => {
        clearTimeout(t);
        let m;
        try { m = JSON.parse(String(raw)); } catch { return ws.close(4400, "bad register"); }
        if (m?.t !== "register" || typeof m.token !== "string" || m.token.length < 32 || m.token.length > 256) return ws.close(4400, "bad register");
        const h = sha(m.token);
        const b = bindings.get(hostId);
        if (!b && !hosts.has(hostId) && C.maxHosts && hosts.size >= C.maxHosts) { stats.rejected++; return ws.close(4503, "relay full"); }
        if (!b) { bindings.set(hostId, { h, seen: Date.now() }); persist(); }
        else if (!eq(b.h, h)) { stats.rejected++; ws.send(JSON.stringify({ t: "error", reason: "host id is bound to another key" })); return ws.close(4403, "forbidden"); }
        else { b.seen = Date.now(); persist(); }
        hosts.get(hostId)?.ws.close(4409, "replaced");
        const entry = { ws, lanes: new Set() };
        hosts.set(hostId, entry);
        stats.hosts++;
        ws.send(JSON.stringify({ t: "registered" }));
        ws.on("message", () => {}); // keepalives from the host are fine
        ws.on("close", () => { if (hosts.get(hostId) === entry) hosts.delete(hostId); });
      });
      return;
    }
    if (kind === "connect") {
      const h = hosts.get(hostId);
      if (!h) return ws.close(4503, "host offline");
      if (h.lanes.size + [...pending.values()].filter((p) => p.hostId === hostId).length >= C.maxLanes) return ws.close(4429, "too many lanes");
      const id = randomBytes(16).toString("hex");
      const p = { hostId, client: ws, queue: [], qbytes: 0, timer: setTimeout(() => { pending.delete(id); ws.close(4504, "host did not attach"); }, C.pendingMs) };
      pending.set(id, p);
      ws.on("message", (d, bin) => { if (!p.queue) return; p.qbytes += d.length ?? 0; if (p.qbytes > 4 * C.maxFrame) return ws.close(4413, "too much data before attach"); p.queue.push([d, bin]); });
      ws.on("close", () => { if (pending.get(id) === p) { clearTimeout(p.timer); pending.delete(id); } });
      h.ws.send(JSON.stringify({ t: "lane", lane: id }));
      return;
    }
    if (kind === "lane") {
      const p = pending.get(lane ?? "");
      const token = u.searchParams.get("token") ?? "";
      const b = bindings.get(hostId);
      if (!p || p.hostId !== hostId || !b || !eq(b.h, sha(token))) { stats.rejected++; return ws.close(4403, "forbidden"); }
      pending.delete(lane);
      clearTimeout(p.timer);
      const h = hosts.get(hostId);
      h?.lanes.add(ws);
      ws.on("close", () => h?.lanes.delete(ws));
      stats.lanes++;
      stats.lanesOpen++;
      p.client.removeAllListeners("message");
      for (const [d, bin] of p.queue) { audit(d); ws.send(d, { binary: bin }); }
      p.queue = null;
      pipe(p.client, ws);
      return;
    }
    ws.close(4404, "unknown endpoint");
  }

  const ping = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
    const now = Date.now();
    for (const [ip, r] of rate) if (now > r.reset) rate.delete(ip);
  }, C.pingMs);
  const housekeeping = setInterval(() => { prune(); flush(); }, 15_000);
  http.on("close", () => { clearInterval(ping); clearInterval(housekeeping); flush(); });
  http.stats = stats;
  http.shutdown = () => new Promise((resolve) => {
    for (const ws of wss.clients) ws.close(1001, "relay restarting");
    flush();
    http.close(() => resolve());
    setTimeout(resolve, 3000).unref?.();
  });
  return new Promise((resolve) => http.listen(C.port, C.host, () => { log(`supercharge relay listening on ${C.host}:${http.address().port}`); resolve(http); }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRelay().then((s) => {
    const stop = () => s.shutdown().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
}
