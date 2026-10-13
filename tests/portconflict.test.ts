import { afterEach, describe, expect, it } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { pendingCredsFromCode } from "../src/mobile/creds";
import { candidates, GatewayTransport } from "../src/gateway/transport";

/**
 * Port conflict end to end with the real headless server: 2420 is taken by another program,
 * the gateway moves to a free port, the pairing code advertises it, a phone pairs there; after a
 * restart with that port taken too, the paired phone finds the gateway again by itself.
 */
const BIN = process.env.SCS_BIN ?? join(process.cwd(), "server/target/" + (existsSync("server/target/release/supercharge-studio-server") ? "release" : "debug") + "/supercharge-studio-server" + (process.platform === "win32" ? ".exe" : ""));
const occupy = (port: number) => new Promise<Server | null>((r) => { const s = createServer(); s.once("error", () => r(null)); s.listen(port, "0.0.0.0", () => r(s)); });
const procs: ChildProcess[] = [];
// Minimal agent: accepts the server's ACP socket and answers initialize.
let agentUrl = "";
const agent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
agent.on("connection", (ws) => ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id !== undefined && m.method) ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : {} })); }));
agent.on("listening", () => { agentUrl = `ws://127.0.0.1:${(agent.address() as any).port}`; });
afterEach(() => { procs.forEach((p) => p.kill()); procs.length = 0; });
function start(data: string, control: string): Promise<{ p: ChildProcess; log: string[] }> {
  const p = spawn(BIN, ["run", "--agent", agentUrl, "--agent-secret", "x", "--data-dir", data, "--control", control, "--name", "Conflict"], { stdio: ["ignore", "ignore", "pipe"] });
  procs.push(p);
  const log: string[] = [];
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("server did not start: " + log.join(""))), 15000);
    p.stderr!.on("data", (d) => { log.push(String(d)); if (log.join("").includes("pair a phone")) { clearTimeout(t); res({ p, log }); } });
    p.on("exit", (c) => rej(new Error(`server exited ${c}: ${log.join("")}`)));
  });
}
async function pairCode(data: string, control: string) {
  const p = spawn(BIN, ["pair", "--yes", "--data-dir", data, "--control", control], { stdio: ["ignore", "pipe", "ignore"] });
  procs.push(p);
  return new Promise<string>((res) => { let b = ""; p.stdout!.on("data", (d) => { b += d; const m = b.match(/scstudio:\/\/pair\?\S+/); if (m) res(m[0]); }); });
}

describe.skipIf(!existsSync(BIN))("gateway port conflicts", () => {
  it("moves off a taken port, advertises it, and paired phones follow it after a restart", async () => {
    const data = mkdtempSync(join(tmpdir(), "scs-port-"));
    const control = "127.0.0.1:2499";
    const busy = await occupy(2420);
    const s1 = await start(data, control);
    const code = await pairCode(data, control);
    const creds = await pendingCredsFromCode(code, "Phone");
    const port1 = Number(new URL(creds.url).port);
    expect(port1).not.toBe(2420);
    if (busy) expect(s1.log.join("")).toMatch(/port 2420 unavailable/);
    const lo = (u: string) => u.replace(/\/\/[^:/]+:/, "//127.0.0.1:");
    const t = new GatewayTransport([lo(creds.url)], creds.deviceId, creds.key, "Phone", WebSocket as any, undefined, 10000);
    await t.open().catch((e) => { throw new Error(e.message + "\n" + creds.url + "\n" + s1.log.join("")); });
    expect(t.deviceId).toBeTruthy();
    t.close();
    s1.p.kill();
    await new Promise((r) => setTimeout(r, 500));
    // Restart with the remembered port taken as well: the server picks another one...
    const busy2 = await occupy(port1);
    const s2 = await start(data, control);
    expect(s2.log.join("")).toMatch(new RegExp(`port ${port1} unavailable`));
    // ...and the phone, holding only the old address, finds it by probing the gateway port range.
    const t2 = new GatewayTransport(candidates({ url: lo(creds.url) }), t.deviceId, creds.key, "Phone", WebSocket as any, undefined, 1500);
    await t2.open().catch((e) => { throw new Error(e.message + "\nS2:" + s2.log.join("")); });
    expect(Number(new URL(t2.connectedUrl).port)).not.toBe(port1);
    t2.close();
    s2.p.kill();
    busy?.close();
    busy2?.close();
  }, 60000);
});
