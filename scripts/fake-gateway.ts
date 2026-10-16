/**
 * Test double of the desktop gateway (same wire protocol as src-tauri/src/gateway.rs),
 * backed by the real GatewayHub and a scripted "desktop". Used by the mobile e2e tests.
 *
 *   GET /pair            → { uri }  new one-time pairing code (auto-approved)
 *   GET /handoff?sid=..  → send a handoff to all devices
 *   GET /pair?relay=1    → same, but the direct URL is unreachable and `r=` points at the relay
 *   GET /relay-stats     → frames forwarded by the relay double and whether any was plaintext
 *   GET /perm            → raise a permission request on session s1; result at /perm-result
 */
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { b64, Channel, deviceKey, hmac, random, sessionKey } from "../src/gateway/crypto";
import { GatewayHub } from "../src/gateway/hub";
// @ts-ignore plain JS module
import { startRelay } from "../relay/server.mjs";
let relayStats: any = {};

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 2431);
const pairings = new Map<string, Uint8Array>(); // pairing id -> device key
const devices = new Map<string, Uint8Array>(); // device id -> key
const conns = new Map<string, (m: any) => void>();
let permResult: any = null;
const uploads: Record<string, { name: string; mimeType: string; parts: string[] }> = {};
let lastAttachments: any[] = [];
const sessions = [
  { sessionId: "s1", title: "Fix login bug", cwd: "/work/api", project: "api", projectId: "p1", group: "Work" },
  { sessionId: "s2", title: "Write release notes", cwd: "/work/docs", project: "docs", projectId: "p2", group: "Work" },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hub: GatewayHub = new GatewayHub((d, m) => conns.get(d)?.(m), {
  sessions: () => sessions,
  projects: () => [{ projectId: "p1", name: "api", cwd: "/work/api", group: "Work" }, { projectId: "p2", name: "docs", cwd: "/work/docs", group: "Work" }],
  async upload(p: any) {
    const u = (uploads[p.uploadId] ??= { name: p.name, mimeType: p.mimeType, parts: [] });
    u.parts[p.index] = p.data;
    if (p.index < p.total - 1) return { received: p.index };
    const size = u.parts.reduce((n: number, d: string) => n + Buffer.from(d, "base64").length, 0);
    return { uploadId: p.uploadId, uri: `file:///uploads/${p.name}`, path: `/uploads/${p.name}`, name: p.name, mimeType: p.mimeType, size };
  },
  async resolveUploads(blocks: any[]) {
    return blocks.map((b) => (b?._meta?.supercharge?.uploadId ? { type: "resource_link", uri: b.uri, name: b.name, mimeType: b.mimeType, size: b.size } : b));
  },
  async prompt(sid, text, _from, extra: any[] = []) {
    if (extra.length) lastAttachments = extra;
    hub.update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    if (extra.length) hub.update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text: `${text ? "\n" : ""}📎 ${extra.map((b: any) => b.name).join(", ")}` } });
    if (extra.length) hub.update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Got ${extra.length} attachment(s): ${extra.map((b: any) => b.name ?? b.type).join(", ")}. ` } });
    if (/perm/.test(text)) {
      const { answer } = hub.requestPermission(sid, { toolCall: { toolCallId: "t9", title: "Run npm test", rawInput: { command: "npm test" } }, options: [{ optionId: "y", name: "Allow once", kind: "allow_once" }, { optionId: "n", name: "Reject", kind: "reject_once" }] });
      const o = await answer;
      hub.update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Permission: ${o.outcome}${(o as any).optionId ? `:${(o as any).optionId}` : ""}` } });
      return { stopReason: "end_turn" };
    }
    for (const w of ["Sure", " — ", "working", " on ", "it."]) {
      hub.update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: w } });
      await sleep(40);
    }
    hub.contextUsage(sid, 52300, windows.get(sid) ?? 200000);
    hub.update(sid, { sessionUpdate: "tool_call", toolCallId: `t${Date.now()}`, title: "Edit src/login.ts", kind: "edit", status: "completed", content: [{ type: "diff", path: "src/login.ts", oldText: "a\nb", newText: "a\nB" }] });
    return { stopReason: "end_turn" };
  },
  cancel() {},
  async newSession(pid) {
    const s = { sessionId: `s${sessions.length + 1}`, title: "New chat", cwd: "/work/x", project: pid === "p1" ? "api" : "docs", projectId: pid, group: "Work" };
    sessions.push(s);
    return s.sessionId;
  },
  focus() {},
  windowSupport: (sid) => ({ via: "ext", current: windows.get(sid) ?? null }),
  async setContextWindow(sid, v) {
    windows.set(sid, v === "auto" ? null : v);
    const max = v === "auto" ? 200000 : v;
    hub.contextUsage(sid, 52300, max);
    return { contextWindow: max };
  },
});
const windows = new Map<string, number | null>();
hub.seed("s1", [
  { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Why does login fail?" } },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The **token** check is inverted." } },
]);

const http = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  if (u.pathname === "/pair") {
    const id = `p-${Date.now()}`;
    const secret = random(32);
    pairings.set(id, await deviceKey(secret));
    const k = b64.enc(secret).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const direct = u.searchParams.get("relay") ? "ws://127.0.0.1:9/gw" : `ws://127.0.0.1:${port}/gw`;
    const relay = u.searchParams.get("relay") ? `&r=${encodeURIComponent(`ws://127.0.0.1:${port + 1}/v1/connect/test-host`)}` : "";
    return res.end(JSON.stringify({ uri: `scstudio://pair?u=${encodeURIComponent(direct)}&i=${id}&k=${k}&n=Test%20Desktop${relay}` }));
  }
  if (u.pathname === "/attachments") return res.end(JSON.stringify(lastAttachments));
  if (u.pathname === "/relay-stats") return res.end(JSON.stringify(relayStats));
  if (u.pathname === "/drop") { for (const c of wss.clients) c.terminate(); return res.end("{}"); }
  if (u.pathname === "/handoff") return res.end(JSON.stringify({ n: hub.handoff(u.searchParams.get("sid") ?? "s2") }));
  if (u.pathname === "/perm") {
    permResult = null;
    const { answer } = hub.requestPermission("s1", { toolCall: { toolCallId: "t1", title: "Delete dist" }, options: [{ optionId: "ok", name: "Allow once", kind: "allow_once" }] });
    answer.then((o) => (permResult = o));
    return res.end("{}");
  }
  if (u.pathname === "/perm-result") return res.end(JSON.stringify(permResult));
  res.statusCode = 404;
  res.end("{}");
});
const wss = new WebSocketServer({ server: http, path: "/gw" });
const onConn = (ws: import("ws").WebSocket) => {
  let ch: Channel | null = null;
  let nc: Uint8Array, ns: Uint8Array, sk: Uint8Array, key: Uint8Array | undefined, id = "", pairing = false;
  let chain = Promise.resolve();
  ws.on("message", (raw, isBinary) => {
    chain = chain.then(async () => {
      if (ch && isBinary) {
        const msg = JSON.parse(await ch.open(new Uint8Array(raw as Buffer)));
        void hub.receive(id, msg); // never block the socket (permission answers arrive mid-prompt)
        return;
      }
      const m = JSON.parse(String(raw));
      if (m.t === "hello") {
        id = m.id;
        key = pairings.get(id) ?? devices.get(id);
        pairing = pairings.has(id);
        pairings.delete(id);
        if (!key) return ws.send(JSON.stringify({ t: "denied", reason: "unknown device or expired pairing" }));
        nc = b64.dec(m.nc);
        ns = random(16);
        ws.send(JSON.stringify({ t: "challenge", ns: b64.enc(ns) }));
      } else if (m.t === "auth" && key) {
        sk = await sessionKey(key, nc, ns);
        if (m.mac !== b64.enc(await hmac(sk, "client", nc, ns))) return ws.send(JSON.stringify({ t: "denied", reason: "authentication failed" }));
        if (pairing) { id = `d-${devices.size + 1}`; devices.set(id, key); }
        ch = await Channel.create(sk, true);
        const c = ch;
        let out = Promise.resolve();
        conns.set(id, (msg) => (out = out.then(async () => ws.send(await c.seal(JSON.stringify(msg))))));
        hub.connected(id);
        ws.send(JSON.stringify({ t: "ok", mac: b64.enc(await hmac(sk, "server", nc, ns)), deviceId: id }));
      }
    }).catch((e) => console.error(e));
  });
  ws.on("close", () => { conns.delete(id); hub.disconnected(id); });
};
wss.on("connection", onConn);
http.listen(port, "127.0.0.1", () => console.log(`fake gateway on ws://127.0.0.1:${port}/gw`));


// ---- Relay: the reference relay (relay/server.mjs) with this gateway attached as host ----
// Exactly what the desktop/server do: keep a control socket, open one lane per phone and
// run the normal gateway handshake over it. The relay never sees keys or plaintext.
const relayPort = port + 1;
const relayToken = "f".repeat(64);
relayStats = (await startRelay(relayPort, "127.0.0.1")).stats;
function hostLoop() {
  const ctl = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/host/test-host`);
  ctl.on("open", () => ctl.send(JSON.stringify({ t: "register", token: relayToken })));
  ctl.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === "lane") {
      const lane = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/lane/test-host/${m.lane}?token=${relayToken}`);
      lane.on("open", () => onConn(lane as any));
    }
  });
  ctl.on("close", () => setTimeout(hostLoop, 500));
  ctl.on("error", () => {});
}
hostLoop();
