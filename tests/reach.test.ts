import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY, effectiveRelay, ensureHostId, reachOf, relayConnect } from "../src/lib/reach";

describe("Local / Public connection", () => {
  it("defaults new installs to Public with the built-in relay", () => {
    expect(reachOf({})).toBe("public");
    expect(effectiveRelay({})).toBe(DEFAULT_RELAY);
  });
  it("keeps older installs: empty relay meant local, a relay meant public", () => {
    expect(reachOf({ relayUrl: "" })).toBe("local");
    expect(reachOf({ relayUrl: "wss://r.example" })).toBe("public");
  });
  it("Local never uses a relay; a custom URL overrides the built-in one", () => {
    expect(effectiveRelay({ reach: "local", relayUrl: "wss://r.example" })).toBeUndefined();
    expect(effectiveRelay({ reach: "public", relayUrl: "wss://r.example/" })).toBe("wss://r.example");
    expect(effectiveRelay({ reach: "public", relayUrl: "junk" })).toBe(DEFAULT_RELAY);
  });
  it("Public gets a host id and a connect URL", () => {
    const p = ensureHostId({ reach: "public" as const });
    expect(p.hostId).toMatch(/^[0-9a-f]{24}$/);
    expect(relayConnect(p)).toBe(`${DEFAULT_RELAY}/v1/connect/${p.hostId}`);
    expect(ensureHostId({ reach: "local" as const }).hostId).toBeUndefined();
    expect(relayConnect({ reach: "local", hostId: "abc" })).toBeUndefined();
  });
});
