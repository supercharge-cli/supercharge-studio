import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AcpClient } from "../src/acp/client";
import { BROWSER_METHODS, BrowserController, browserClientMeta } from "../src/browser/bridge";
import { MockAgent, send, until } from "./mockAgent";

let agent: MockAgent;
let client: AcpClient;
afterEach(async () => {
  client?.close();
  await agent?.stop();
});

describe("browser bridge over ACP", () => {
  it("advertises browser methods and serves agent navigate requests", async () => {
    agent = await new MockAgent().start();
    client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { enabled: false }, clientMeta: browserClientMeta() });
    const b = new BrowserController();
    b.attach(client);
    await client.connect();
    await client.initialize();
    const init = agent.received.find((m) => m.method === "initialize");
    expect(init.params.clientCapabilities._meta.supercharge.browser.methods).toEqual(BROWSER_METHODS);
    send(agent.sockets[0], { id: 77, method: "_supercharge/browser/navigate", params: { url: "superchargeai.in" } });
    await until(() => agent.received.some((m) => m.id === 77));
    expect(agent.received.find((m) => m.id === 77).result).toEqual({ url: "https://superchargeai.in" });
    expect(b.url).toBe("https://superchargeai.in");
    // DOM control needs the desktop webview: returns a JSON-RPC error, not a hang.
    send(agent.sockets[0], { id: 78, method: "_supercharge/browser/snapshot", params: {} });
    await until(() => agent.received.some((m) => m.id === 78));
    expect(agent.received.find((m) => m.id === 78).error.message).toMatch(/desktop/);
  });
});

import { wrapScript } from "../src/browser/bridge";
describe("page scripts", () => {
  it("are valid JS expressions", () => {
    for (const e of ["__sc.snapshot()", "(__sc.find({\"ref\":1,\"selector\":null}).click(), true)", "document.title"])
      expect(() => new Function(`return ${wrapScript(e)};`)).not.toThrow();
  });
});
