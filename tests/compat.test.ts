/** Shapes observed from a live `supercharge agent serve` (1.3.x). */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AcpClient, AcpRpcError, discoverExtensions, isAuthError, rpcErrorMessage } from "../src/acp/client";
import { applyUpdate, emptySession } from "../src/acp/session";
import { MockAgent, reply, send, until } from "./mockAgent";

let agent: MockAgent;
let client: AcpClient;
afterEach(async () => {
  client?.close();
  await agent?.stop();
});

describe("live-agent compatibility", () => {
  it("collects namespaced _meta features", () => {
    const e = discoverExtensions({
      protocolVersion: 1,
      agentCapabilities: { _meta: { "supercharge/fs_notify": true, "supercharge/hooks": { decisions: ["deny"] }, "supercharge/off": false } },
      _meta: { agentVersion: "1.3.30", "supercharge/mcp/sdk": true },
    });
    expect(e.features).toEqual(["supercharge/fs_notify", "supercharge/hooks", "supercharge/mcp/sdk"]);
    expect(e.methods).toEqual([]);
  });

  it("surfaces error.data when message is generic", () => {
    expect(rpcErrorMessage({ message: "Internal error", data: "Unauthorized (401): no auth context" })).toBe(
      "Internal error: Unauthorized (401): no auth context",
    );
    expect(isAuthError(new Error("Internal error: Unauthorized (401)"))).toBe(true);
    expect(isAuthError(new Error("boom"))).toBe(false);
  });

  it("prompt failure without provider key rejects with readable auth error; tracks ext notifications", async () => {
    agent = await new MockAgent().start();
    agent.on("session/prompt", (m, s) => {
      send(s, { method: "_supercharge/queue/changed", params: {} });
      send(s, { id: m.id, error: { code: -32603, message: "Internal error", data: "Unauthorized (401): Invalid or expired credentials" } });
    });
    client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { enabled: false } });
    await client.connect();
    await client.initialize();
    const err = await client.prompt("sess-1", "ping").catch((e) => e);
    expect(err).toBeInstanceOf(AcpRpcError);
    expect(isAuthError(err)).toBe(true);
    expect(err.message).toMatch(/401/);
    expect(client.extensions.notifications).toEqual(["_supercharge/queue/changed"]);
  });

  it("supports session/list, resume, close when advertised", async () => {
    agent = await new MockAgent().start();
    agent.on("initialize", (m, s) => reply(s, m.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } } }));
    agent.on("session/list", (m, s) => reply(s, m.id, { sessions: [{ sessionId: "a", cwd: "/x" }] }));
    agent.on("session/resume", (m, s) => reply(s, m.id, {}));
    agent.on("session/close", (m, s) => reply(s, m.id, {}));
    client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { enabled: false } });
    await client.connect();
    await client.initialize();
    expect(client.sessionCapability("list")).toBe(true);
    expect((await client.listSessions()).sessions[0].sessionId).toBe("a");
    await client.resumeSession("a", "/x");
    await client.closeSession("a");
    await until(() => agent.received.some((m) => m.method === "session/close"));
    expect(agent.received.find((m) => m.method === "session/resume").params).toEqual({ sessionId: "a", cwd: "/x", mcpServers: [] });
  });

  it("applies session_info_update title", () => {
    const s = applyUpdate(emptySession(), { sessionUpdate: "session_info_update", title: "Fix the build" });
    expect(s.title).toBe("Fix the build");
  });
});

import { isModelError } from "../src/acp/client";
import { BROWSER_METHODS, BrowserController } from "../src/browser/bridge";
describe("model errors and browser ops", () => {
  it("detects unsupported-model errors", () => {
    expect(isModelError(new Error("Internal error: 400 no upstream owns model foo-1"))).toBe(true);
    expect(isModelError(new Error("model 'x' not found"))).toBe(true);
    expect(isModelError(new Error("Unauthorized (401)"))).toBe(false);
  });
  it("advertises screenshot and falls back to snapshot outside the desktop app", async () => {
    expect(BROWSER_METHODS).toContain("_supercharge/browser/screenshot");
    const r: any = await new BrowserController().run("screenshot", {});
    expect(r.fallback).toBe("snapshot");
    expect(r.error).toMatch(/desktop/);
    await expect(new BrowserController().run("nope", {})).rejects.toThrow(/unknown/);
  });
});
