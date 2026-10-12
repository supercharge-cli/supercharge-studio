/**
 * Test double of the desktop gateway (same wire protocol as src-tauri/src/gateway.rs),
 * backed by the real GatewayHub and a scripted "desktop". Used by the mobile e2e tests.
 *
 *   GET /pair            → { uri }  new one-time pairing code (auto-approved)
 *   GET /handoff?sid=..  → send a handoff to all devices
 *   GET /perm            → raise a permission request on session s1; result at /perm-result
 */
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { b64, Channel, deviceKey, hmac, random, sessionKey } from "../src/gateway/crypto";
import { GatewayHub } from "../src/gateway/hub";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 2431);
const pairings = new Map<string, Uint8Array>(); // pairing id -> device key
const devices = new Map<string, Uint8Array>(); // device id -> key
const conns = new Map<string, (m: any) => void>();
let permResult: any = null;
const sessions = [
  { sessionId: "s1", title: "Fix login bug", cwd: "/work/api", project: "api", projectId: "p1", group: "Work" },
  { sessionId: "s2", title: "Write release notes", cwd: "/work/docs", project: "docs", projectId: "p2", group: "Work" },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hub: GatewayHub = new GatewayHub((d, m) => conns.get(d)?.(m), {
  sessions: () => sessions,
  projects: () => [{ projectId: "p1", name: "api", cwd: "/work/api", group: "Work" }, { projectId: "p2", name: "docs", cwd: "/work/docs", group: "Work" }],
  async prompt(sid, text) {
    hub.update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
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
});
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
    return res.end(JSON.stringify({ uri: `scstudio://pair?u=${encodeURIComponent(`ws://127.0.0.1:${port}/gw`)}&i=${id}&k=${k}&n=Test%20Desktop` }));
  }
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
wss.on("connection", (ws) => {
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
});
http.listen(port, "127.0.0.1", () => console.log(`fake gateway on ws://127.0.0.1:${port}/gw`));
