import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AcpClient } from "../src/acp/client";
import { AfterReconnect, offline } from "../src/mobile/offline";
import { MockAgent, until } from "./mockAgent";

describe("phone actions while the link is down", () => {
  it("recognises link-down rejections only", () => {
    expect(offline(new Error("Not connected"))).toBe(true);
    expect(offline(new Error("Connection closed"))).toBe(true);
    expect(offline(new Error("Connection lost: timeout"))).toBe(true);
    expect(offline(new Error("Method not found: session/list"))).toBe(false);
    expect(offline("boom")).toBe(false);
  });

  it("keeps the action instead of rejecting, and runs the latest one once after reconnecting", async () => {
    const later = new AfterReconnect();
    const ran: string[] = [];
    expect(await later.run(false, async () => { ran.push("a"); })).toBe(false);
    expect(await later.run(false, async () => { ran.push("b"); })).toBe(false);
    expect(ran).toEqual([]);
    await later.flush();
    await later.flush();
    expect(ran).toEqual(["b"]);
  });

  it("a drop during the action keeps it; other errors still surface", async () => {
    const later = new AfterReconnect();
    let tries = 0;
    expect(await later.run(true, async () => { if (++tries === 1) throw new Error("Not connected"); })).toBe(false);
    await later.flush();
    expect(tries).toBe(2);
    await expect(later.run(true, async () => { throw new Error("No such project"); })).rejects.toThrow("No such project");
    expect(await later.run(true, async () => {})).toBe(true);
  });
});

describe("client requests on a closed socket", () => {
  let agent: MockAgent;
  let client: AcpClient | null = null;
  beforeEach(async () => { agent = await new MockAgent().start(); });
  afterEach(async () => { client?.close(); client = null; await agent.stop(); });

  it("reject with a link-down error that the phone handles (listSessions / newSession)", async () => {
    const c = (client = new AcpClient({ url: agent.url, WebSocketImpl: WebSocket as any, reconnect: { initialDelayMs: 60_000 } }));
    await c.connect();
    await agent.stop();
    await until(() => c.state !== "open");
    const later = new AfterReconnect();
    const errs = await Promise.all([c.listSessions().catch((e) => e), c.newSession("/tmp").catch((e) => e)]);
    for (const e of errs) expect(offline(e)).toBe(true);
    expect(await later.run(c.state === "open", () => c.newSession("/tmp"))).toBe(false);
  });
});
