import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AcpClient, discoverExtensions } from "../src/acp/client";
import { STEER_METHOD } from "../src/acp/steer";
import { canonicalName, isLegacyName, legacyName, LegacyNotificationDedup } from "../src/acp/legacyNames";
import { MockAgent, send, until } from "./mockAgent";

const legacy = (n: string) => legacyName(n);
const legacyKey = (n: string) => legacyName(n, true);

let agent: MockAgent;
let client: AcpClient;
afterEach(async () => {
  client?.close();
  await agent?.stop();
});

describe("legacy ACP extension names", () => {
  it("maps legacy names to _supercharge/ and leaves others alone", () => {
    expect(canonicalName(legacy("mcp/server_status"))).toBe("_supercharge/mcp/server_status");
    expect(canonicalName(legacyKey("fs_notify"))).toBe("_supercharge/fs_notify");
    expect(canonicalName("_supercharge/interject")).toBe("_supercharge/interject");
    expect(canonicalName("session/update")).toBe("session/update");
    expect(isLegacyName(legacy("hooks"))).toBe(true);
    expect(isLegacyName("_supercharge/hooks")).toBe(false);
    expect(STEER_METHOD).toBe("_supercharge/session/steer");
  });

  it("dedup drops only the legacy copy of a dual-sent notification", () => {
    const d = new LegacyNotificationDedup();
    const p = { a: 1 };
    expect(d.accept("_supercharge/fs_notify", p)).toBe(true);
    expect(d.accept(legacy("fs_notify"), p)).toBe(false);
    // Legacy-only (older CLI) is processed.
    expect(d.accept(legacy("fs_notify"), p)).toBe(true);
    expect(d.accept(legacy("fs_notify"), { a: 2 })).toBe(true);
  });

  it("reads capabilities under either key, _supercharge/ wins", () => {
    const e = discoverExtensions({
      protocolVersion: 1,
      agentCapabilities: { _meta: { [legacyKey("fs_notify")]: true, "_supercharge/fs_notify": true, [legacyKey("hooks")]: { v: "old" }, "_supercharge/hooks": { v: "new" } } },
      _meta: { [legacyKey("mcp/sdk")]: true },
    });
    expect(e.features).toEqual(["_supercharge/fs_notify", "_supercharge/hooks", "_supercharge/mcp/sdk"]);
    expect(e.meta["_supercharge/hooks"]).toEqual({ v: "new" });
    expect(e.meta["_supercharge/mcp/sdk"]).toBe(true);
  });

  it("handles dual-sent notifications once and legacy-only ones too", async () => {
    agent = await new MockAgent().start();
    const got: [string, unknown][] = [];
    client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { enabled: false }, onNotification: (m, p) => got.push([m, p]) });
    await client.connect();
    await client.initialize();
    const s = agent.sockets[0];
    send(s, { method: "_supercharge/mcp/servers_updated", params: { n: 1 } });
    send(s, { method: legacy("mcp/servers_updated"), params: { n: 1 } });
    send(s, { method: legacy("session_notification"), params: { n: 2 } });
    send(s, { method: "_supercharge/done", params: {} });
    await until(() => got.some(([m]) => m === "_supercharge/done"));
    expect(got).toEqual([
      ["_supercharge/mcp/servers_updated", { n: 1 }],
      ["_supercharge/session_notification", { n: 2 }],
      ["_supercharge/done", {}],
    ]);
  });

  it("answers CLI requests under both legacy and _supercharge/ names", async () => {
    agent = await new MockAgent().start();
    client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { enabled: false } });
    client.handle("_supercharge/ask_user_question", async (p: any) => ({ answer: p.q }));
    await client.connect();
    await client.initialize();
    const s = agent.sockets[0];
    send(s, { id: 901, method: legacy("ask_user_question"), params: { q: "old" } });
    send(s, { id: 902, method: "_supercharge/ask_user_question", params: { q: "new" } });
    await until(() => agent.received.some((m) => m.id === 902 && "result" in m) && agent.received.some((m) => m.id === 901 && "result" in m));
    expect(agent.received.find((m) => m.id === 901).result).toEqual({ answer: "old" });
    expect(agent.received.find((m) => m.id === 902).result).toEqual({ answer: "new" });
  });
});
