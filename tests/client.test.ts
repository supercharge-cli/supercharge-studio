import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AcpClient, AcpRpcError, AcpTimeoutError, discoverExtensions } from "../src/acp/client";
import { MockAgent, reply, send, until } from "./mockAgent";

let agent: MockAgent;
let client: AcpClient | null;

const mk = (o: Partial<ConstructorParameters<typeof AcpClient>[0]> = {}) =>
  (client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { enabled: false }, ...o }));

beforeEach(async () => {
  agent = await new MockAgent().start();
});
afterEach(async () => {
  client?.close();
  client = null;
  await agent.stop();
});

describe("AcpClient", () => {
  it("initializes and discovers extension methods", async () => {
    const c = mk();
    await c.connect();
    const init = await c.initialize();
    expect(init.protocolVersion).toBe(1);
    expect(c.extensions.methods).toEqual(["_supercharge/fs/tree", "_supercharge/git/status"]);
    expect(c.hasExtension("supercharge/fs/tree")).toBe(true);
    const sent = agent.received.find((m) => m.method === "initialize");
    expect(sent.params.protocolVersion).toBe(1);
    expect(sent.params.clientInfo.name).toBe("supercharge-studio");
  });

  it("tracks request ids and matches out-of-order responses", async () => {
    agent.on("a", (m, s) => setTimeout(() => reply(s, m.id, "A"), 30));
    agent.on("b", (m, s) => reply(s, m.id, "B"));
    const c = mk();
    await c.connect();
    const [a, b] = await Promise.all([c.request("a"), c.request("b")]);
    expect([a, b]).toEqual(["A", "B"]);
    const ids = agent.received.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(c.pendingCount).toBe(0);
  });

  it("rejects with AcpRpcError on JSON-RPC error", async () => {
    agent.on("bad", (m, s) => send(s, { id: m.id, error: { code: -32602, message: "nope" } }));
    const c = mk();
    await c.connect();
    const err = await c.request("bad").catch((e) => e);
    expect(err).toBeInstanceOf(AcpRpcError);
    expect(err.code).toBe(-32602);
  });

  it("times out unanswered requests", async () => {
    const c = mk({ requestTimeoutMs: 50 });
    await c.connect();
    const err = await c.request("silent").catch((e) => e);
    expect(err).toBeInstanceOf(AcpTimeoutError);
    expect(c.pendingCount).toBe(0);
  });

  it("dispatches session/update incl. tool_call and tool_call_update", async () => {
    const updates: any[] = [];
    agent.on("session/prompt", (m, s) => {
      const sid = m.params.sessionId;
      send(s, { method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
      send(s, { method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run ls", kind: "execute", status: "pending" } } });
      // NDJSON batch in one frame
      s.send(
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } } }) +
          "\n" +
          JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }),
      );
    });
    const c = mk({ onUpdate: (sid, u) => updates.push([sid, u.sessionUpdate]) });
    await c.connect();
    const { sessionId } = await c.newSession("/tmp");
    const res = await c.prompt(sessionId, "hello");
    expect(res.stopReason).toBe("end_turn");
    expect(updates).toEqual([
      ["sess-1", "agent_message_chunk"],
      ["sess-1", "tool_call"],
      ["sess-1", "tool_call_update"],
    ]);
  });

  it("replies to session/request_permission via handler", async () => {
    const c = mk({
      onPermissionRequest: (req) => ({ outcome: "selected", optionId: req.options[0].optionId }),
    });
    await c.connect();
    send(agent.sockets[0], {
      id: "p1",
      method: "session/request_permission",
      params: { sessionId: "sess-1", toolCall: { toolCallId: "t1" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
    });
    await until(() => agent.received.some((m) => m.id === "p1"));
    const r = agent.received.find((m) => m.id === "p1");
    expect(r.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("answers unknown agent requests with method-not-found", async () => {
    const c = mk();
    await c.connect();
    send(agent.sockets[0], { id: 9, method: "fs/read_text_file", params: {} });
    await until(() => agent.received.some((m) => m.id === 9));
    expect(agent.received.find((m) => m.id === 9).error.code).toBe(-32601);
  });

  it("sends session/cancel and receives cancelled stopReason", async () => {
    let promptId: any;
    agent.on("session/prompt", (m) => (promptId = m.id));
    agent.on("session/cancel", (_m, s) => reply(s, promptId, { stopReason: "cancelled" }));
    const c = mk();
    await c.connect();
    const p = c.prompt("sess-1", "long task");
    await until(() => promptId !== undefined);
    c.cancel("sess-1");
    expect((await p).stopReason).toBe("cancelled");
    const cancel = agent.received.find((m) => m.method === "session/cancel");
    expect(cancel.id).toBeUndefined();
    expect(cancel.params).toEqual({ sessionId: "sess-1" });
  });

  it("rejects pending requests when connection drops", async () => {
    const c = mk();
    await c.connect();
    const p = c.request("never");
    await until(() => agent.received.length > 0);
    agent.dropAll();
    await expect(p).rejects.toThrow(/Connection lost/);
  });

  it("reconnects with backoff and re-initializes", async () => {
    const states: string[] = [];
    let reconnected = 0;
    const c = mk({
      reconnect: { enabled: true, initialDelayMs: 20, factor: 2, maxDelayMs: 100 },
      onStateChange: (s) => states.push(s),
      onReconnected: () => reconnected++,
    });
    await c.connect();
    await c.initialize();
    agent.dropAll();
    await until(() => reconnected === 1);
    expect(agent.connections).toBe(2);
    expect(states).toContain("reconnecting");
    expect(c.state).toBe("open");
    expect(c.backoffDelay(1)).toBe(20);
    expect(c.backoffDelay(3)).toBe(80);
    expect(c.backoffDelay(10)).toBe(100);
  });

  it("keeps retrying while agent is down, then recovers", async () => {
    const port = agent.port;
    let reconnected = 0;
    const c = mk({ reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 40 }, onReconnected: () => reconnected++ });
    await c.connect();
    await agent.stop();
    await new Promise((r) => setTimeout(r, 150));
    expect(c.state).toBe("reconnecting");
    agent = await new MockAgent().start(port);
    await until(() => reconnected === 1);
    expect(c.state).toBe("open");
  });

  it("does not reconnect after manual close", async () => {
    const c = mk({ reconnect: { enabled: true, initialDelayMs: 10 } });
    await c.connect();
    c.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(agent.connections).toBe(1);
    expect(c.state).toBe("closed");
  });

  it("fails connect on bad server key", async () => {
    const c = new AcpClient({ url: agent.url.replace("secret", "wrong"), WebSocketImpl: WebSocket as any, reconnect: { enabled: false } });
    await expect(c.connect()).rejects.toThrow();
  });
});

describe("discoverExtensions", () => {
  it("handles object-keyed methods and top-level _meta", () => {
    const e = discoverExtensions({ protocolVersion: 1, _meta: { supercharge: { methods: { "supercharge/fs/tree": {}, "supercharge/browser/open": {} } } } });
    expect(e.methods).toEqual(["_supercharge/browser/open", "_supercharge/fs/tree"]);
  });
  it("returns empty for no meta", () => {
    expect(discoverExtensions({ protocolVersion: 1 }).methods).toEqual([]);
  });
});

import { pickConfiguredModel } from "../src/acp/client";
describe("model_not_configured", () => {
  it("picks a configured model, preferring ours, never an unconfigured one", () => {
    const e = new AcpRpcError(-32050, "model_not_configured", { requested: "old", configured: [{ id: "m1" }, "m2"] });
    expect(pickConfiguredModel(e, ["zz", "m2"])).toEqual({ pick: "m2", requested: "old" });
    expect(pickConfiguredModel(e)).toEqual({ pick: "m1", requested: "old" });
    expect(pickConfiguredModel(new AcpRpcError(-32603, "x"))).toBeNull();
    expect(pickConfiguredModel(new AcpRpcError(-32050, "x", { configured: [] }))).toBeNull();
  });
});

import { combineSteer, hasNativeSteer, makeSteerer } from "../src/acp/steer";
describe("steer", () => {
  it("uses the native method only when advertised, else cancel-and-resend", async () => {
    const calls: any[] = [];
    const native = { initResult: { agentCapabilities: { _meta: { supercharge: { steer: true } } } }, request: async (m: string, p: any) => calls.push([m, p]) } as any;
    expect(hasNativeSteer(native)).toBe(true);
    await makeSteerer(native, () => calls.push("cancel"), () => calls.push("resend")).steer("s1", "hi");
    expect(calls).toEqual([["_supercharge/session/steer", { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] }]]);
    calls.length = 0;
    const plain = { initResult: { agentCapabilities: {} }, request: async () => calls.push("req") } as any;
    const s = makeSteerer(plain, (sid) => calls.push(`cancel ${sid}`), (sid, t) => calls.push(`resend ${sid} ${t}`));
    expect(s.mode).toBe("resend");
    await s.steer("s2", "more");
    expect(calls).toEqual(["cancel s2", "resend s2 more"]);
    expect(combineSteer("fix it ", " and add tests")).toBe("fix it\n\nand add tests");
  });
});
