import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { b64, parsePairUri } from "../src/gateway/crypto";
import { candidates, explainFailure, GatewayTransport } from "../src/gateway/transport";

const secret = b64.enc(new Uint8Array(32).fill(7)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const base = `scstudio://pair?u=ws%3A%2F%2F192.168.1.5%3A2420%2Fgw&i=p-1&k=${secret}`;

describe("reaching the desktop", () => {
  it("parses extra direct addresses and drops invalid ones", () => {
    const p = parsePairUri(`${base}&a=ws%3A%2F%2F10.0.0.7%3A2420%2Fgw,javascript%3Ax,ws%3A%2F%2F192.168.1.5%3A2420%2Fgw&r=wss%3A%2F%2Fr.example.com%2Fv1%2Fconnect%2Fh`);
    expect(p.alts).toEqual(["ws://10.0.0.7:2420/gw"]);
    expect(candidates({ url: p.url, alts: p.alts, relay: p.relay })).toEqual(["ws://192.168.1.5:2420/gw", "ws://10.0.0.7:2420/gw", "wss://r.example.com/v1/connect/h"]);
    expect(parsePairUri(base).alts).toBeUndefined();
  });

  it("tries every address, then explains each failure", async () => {
    // A port nobody listens on (refused) and a TCP server that never answers the upgrade (timeout).
    const silent = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const sp = (silent.address() as any).port;
    const t = new GatewayTransport([`ws://127.0.0.1:1/gw`, `ws://127.0.0.1:${sp}/gw`], "p-1", new Uint8Array(32), "test", WebSocket as any, undefined, 800);
    t.probe = false; // other tests may run gateways on 2420..2430 meanwhile
    const err = await t.open().then(() => "", (e) => String(e.message));
    silent.close();
    expect(err).toMatch(/Cannot reach the desktop gateway/);
    expect(err).toContain("127.0.0.1:1: connection refused");
    expect(err).toContain(`127.0.0.1:${sp}: no answer`);
    expect(err).toMatch(/relay URL/);
    expect(t.attempts).toHaveLength(2);
  });

  it("gives network and firewall tips for private addresses", () => {
    const m = explainFailure([{ url: "ws://192.168.1.5:2420/gw", route: "direct", reason: "no answer" }]);
    expect(m).toContain("TCP port 2420");
    expect(m).toContain("http://192.168.1.5:2420/");
  });
});
