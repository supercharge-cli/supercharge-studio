import { pathToFileURL } from "node:url";
// Supercharge Studio reference relay (docs/MOBILE-PLAN.md, "Relay mode").
// A blind pipe between phones and a host (desktop app or headless server). It never sees
// keys or plaintext: every lane carries the gateway's own handshake and AES-GCM frames.
//
//   /v1/host/<hostId>          host control socket   {"t":"register","token"} -> {"t":"registered"}
//   /v1/connect/<hostId>       phone                 relay -> host {"t":"lane","lane"}
//   /v1/lane/<hostId>/<lane>?token=...   host attaches; frames are piped verbatim
//   GET /healthz, GET /v1/stats
//
// Env: PORT (8080), HOST (0.0.0.0), RELAY_DATA (file for host-id -> token-hash bindings),
//      RELAY_AUDIT=1 (tests only: flag frames that look like plaintext JSON-RPC).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_FRAME = 64 * 1024, MAX_LANES = 8, PENDING_MS = 10_000, IDLE_MS = 60_000, PING_MS = 30_000;
const ID = /^[A-Za-z0-9-]{8,64}$/;
const sha = (s) => createHash("sha256").update(s).digest("hex");

const bindings = new Map(Object.entries(load())); // hostId -> sha256(token), trust on first use
const hosts = new Map(); // hostId -> { ws, lanes: Set }
const pending = new Map(); // lane -> { hostId, client, queue, timer }
export const stats = { hosts: 0, lanes: 0, frames: 0, bytes: 0, rejected: 0, plaintextSeen: false };

function load() {
  try { return process.env.RELAY_DATA && existsSync(process.env.RELAY_DATA) ? JSON.parse(readFileSync(process.env.RELAY_DATA, "utf8")) : {}; } catch { return {}; }
}
function persist() {
  if (process.env.RELAY_DATA) writeFileSync(process.env.RELAY_DATA, JSON.stringify(Object.fromEntries(bindings)), { mode: 0o600 });
}
function audit(data, isBinary) {
  stats.frames++;
  stats.bytes += data.length ?? 0;
  if (process.env.RELAY_AUDIT === "1" && Buffer.from(data).toString("latin1").includes('"jsonrpc"')) stats.plaintextSeen = true;
  void isBinary;
}
function pipe(a, b) {
  let idle;
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => { a.close(1000, "idle"); b.close(1000, "idle"); }, IDLE_MS); };
  bump();
  a.on("message", (d, bin) => { audit(d, bin); bump(); if (b.readyState === 1) b.send(d, { binary: bin }); });
  b.on("message", (d, bin) => { audit(d, bin); bump(); if (a.readyState === 1) a.send(d, { binary: bin }); });
  const end = () => { clearTimeout(idle); a.close(); b.close(); };
  a.on("close", end);
  b.on("close", end);
}

export function startRelay(port = PORT, host = process.env.HOST ?? "0.0.0.0") {
  const http = createServer((req, res) => {
    if (req.url === "/healthz") return res.end("ok");
    if (req.url === "/v1/stats") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ...stats, hosts: hosts.size })); }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_FRAME });
  wss.on("connection", (ws, req) => {
    const u = new URL(req.url ?? "/", "http://relay");
    const [, v1, kind, hostId, lane] = u.pathname.split("/");
    if (v1 !== "v1" || !ID.test(hostId ?? "")) return ws.close(4400, "bad path");
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    if (kind === "host") {
      ws.once("message", (raw) => {
        let m;
        try { m = JSON.parse(String(raw)); } catch { return ws.close(4400, "bad register"); }
        if (m?.t !== "register" || typeof m.token !== "string" || m.token.length < 32) return ws.close(4400, "bad register");
        const h = sha(m.token);
        if (!bindings.has(hostId)) { bindings.set(hostId, h); persist(); }
        if (bindings.get(hostId) !== h) { stats.rejected++; ws.send(JSON.stringify({ t: "error", reason: "host id is bound to another key" })); return ws.close(4403, "forbidden"); }
        hosts.get(hostId)?.ws.close(4409, "replaced");
        const entry = { ws, lanes: new Set() };
        hosts.set(hostId, entry);
        ws.send(JSON.stringify({ t: "registered" }));
        ws.on("close", () => { if (hosts.get(hostId) === entry) hosts.delete(hostId); });
      });
      return;
    }
    if (kind === "connect") {
      const h = hosts.get(hostId);
      if (!h) return ws.close(4503, "host offline");
      if (h.lanes.size >= MAX_LANES) return ws.close(4429, "too many lanes");
      const id = randomBytes(16).toString("hex");
      const p = { hostId, client: ws, queue: [], timer: setTimeout(() => { pending.delete(id); ws.close(4504, "host did not attach"); }, PENDING_MS) };
      pending.set(id, p);
      ws.on("message", (d, bin) => p.queue && p.queue.push([d, bin]));
      ws.on("close", () => { if (pending.get(id) === p) { clearTimeout(p.timer); pending.delete(id); } });
      h.ws.send(JSON.stringify({ t: "lane", lane: id }));
      return;
    }
    if (kind === "lane") {
      const p = pending.get(lane ?? "");
      const token = u.searchParams.get("token") ?? "";
      if (!p || p.hostId !== hostId || bindings.get(hostId) !== sha(token)) { stats.rejected++; return ws.close(4403, "forbidden"); }
      pending.delete(lane);
      clearTimeout(p.timer);
      const h = hosts.get(hostId);
      h?.lanes.add(ws);
      ws.on("close", () => h?.lanes.delete(ws));
      stats.lanes++;
      p.client.removeAllListeners("message");
      for (const [d, bin] of p.queue) { audit(d, bin); ws.send(d, { binary: bin }); }
      p.queue = null;
      pipe(p.client, ws);
      return;
    }
    ws.close(4404, "unknown endpoint");
  });
  const ping = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  }, PING_MS);
  http.on("close", () => clearInterval(ping));
  return new Promise((resolve) => http.listen(port, host, () => resolve(http)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRelay().then((s) => console.log(`supercharge relay listening on ${JSON.stringify(s.address())}`));
}
