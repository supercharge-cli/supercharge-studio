import { describe, expect, it } from "vitest";
import { needsFirewall } from "../src/lib/reach";
import { explainFailure } from "../src/gateway/transport";

describe("firewall prompts only in Local mode", () => {
  it("needsFirewall is true only for Local reach on a LAN bind", () => {
    expect(needsFirewall({ reach: "local", mode: "lan" })).toBe(true);
    expect(needsFirewall({ reach: "public", mode: "lan" })).toBe(false);
    expect(needsFirewall({ reach: "local", mode: "loopback" })).toBe(false);
    expect(needsFirewall({ mode: "lan" })).toBe(false); // default reach is Public
  });

  it("phone hints never mention the firewall when a relay route exists", () => {
    const relayed = explainFailure([
      { route: "direct", url: "ws://192.168.1.5:2420/gw", reason: "timed out" },
      { route: "relay", url: "wss://r.example.com/v1/connect/h", reason: "timed out" },
    ] as any, "2420");
    expect(relayed).not.toMatch(/firewall/i);
    const local = explainFailure([{ route: "direct", url: "ws://192.168.1.5:2420/gw", reason: "timed out" }] as any, "2420");
    expect(local).toMatch(/firewall/);
  });
});
