import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AcpClient, PING_METHOD } from "../src/acp/client";
import { GatewayHub } from "../src/gateway/hub";
import { MockAgent, reply, until } from "./mockAgent";

let agent: MockAgent;
let client: AcpClient | null = null;
beforeEach(async () => { agent = await new MockAgent().start(); });
afterEach(async () => { client?.close(); client = null; await agent.stop(); });

describe("fast reconnect", () => {
  it("uses a short backoff capped at 5 s", () => {
    const c = new AcpClient({ url: "ws://x", reconnect: { initialDelayMs: 250, maxDelayMs: 5000, factor: 2 } });
    expect([1, 2, 3, 6, 20].map((n) => c.backoffDelay(n))).toEqual([250, 500, 1000, 5000, 5000]);
  });

  it("reconnectNow skips the backoff wait", async () => {
    let reconnected = 0;
    const port = agent.port;
    const c = (client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { initialDelayMs: 60_000 }, onReconnected: () => reconnected++ }));
    await c.connect();
    await agent.stop();
    await until(() => c.state === "reconnecting");
    agent = await new MockAgent().start(port);
    c.reconnectNow();
    await until(() => reconnected === 1, 2000);
    expect(c.state).toBe("open");
  });

  it("drops a silent socket on a missed ping and reconnects", async () => {
    let reconnected = 0;
    let silent = true;
    agent.on(PING_METHOD, (m, s) => { if (!silent) reply(s, m.id, {}); });
    const c = (client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { initialDelayMs: 10 }, onReconnected: () => reconnected++ }));
    await c.connect();
    expect(await c.checkAlive(50)).toBe(false);
    silent = false;
    await until(() => reconnected === 1, 2000);
    expect(await c.checkAlive(500)).toBe(true);
  });

  it("an error reply to ping still counts as alive (older computers)", async () => {
    const c = (client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { enabled: false } }));
    agent.on(PING_METHOD, (m, s) => s.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } })));
    await c.connect();
    expect(await c.checkAlive(500)).toBe(true);
  });
});

describe("gateway hub resume", () => {
  const host: any = { sessions: () => [{ sessionId: "s1", cwd: "/w" }], projects: () => [], prompt: vi.fn(), cancel: vi.fn(), newSession: vi.fn(), focus: vi.fn() };
  it("answers pings and re-asks open permission questions after a phone reconnects", async () => {
    const sent: any[] = [];
    const hub = new GatewayHub((d, m) => sent.push({ d, m }), host);
    hub.connected("A");
    await hub.receive("A", { id: 1, method: "_supercharge/ping", params: {} });
    expect(sent.at(-1).m.result.t).toBeGreaterThan(0);
    hub.update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
    const { answer } = hub.requestPermission("s1", { toolCall: { toolCallId: "t1" }, options: [] });
    hub.disconnected("A");
    hub.update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " more" } });
    sent.length = 0;
    hub.connected("A");
    await hub.receive("A", { id: 2, method: "session/load", params: { sessionId: "s1" } });
    expect(sent.filter((x) => x.m.method === "session/update").length).toBe(2); // missed updates replayed
    const ask = sent.find((x) => x.m.method === "session/request_permission");
    expect(ask).toBeTruthy();
    await hub.receive("A", { id: ask.m.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    await expect(answer).resolves.toMatchObject({ optionId: "ok" });
    // Loading again doesn't ask twice.
    sent.length = 0;
    await hub.receive("A", { id: 3, method: "session/load", params: { sessionId: "s1" } });
    expect(sent.some((x) => x.m.method === "session/request_permission")).toBe(false);
  });
});
