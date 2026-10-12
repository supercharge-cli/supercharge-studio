import { describe, expect, it } from "vitest";
import { parseAgentUrl } from "../src/lib/store";

describe("parseAgentUrl", () => {
  it("splits a pasted agent URL into address and key", () => {
    expect(parseAgentUrl("ws://127.0.0.1:2419/ws?server-key=abc%2B1")).toEqual({ bind: "127.0.0.1:2419", secret: "abc+1" });
    expect(parseAgentUrl("  wss://host.example:443/ws?server-key=k ")).toEqual({ bind: "host.example", secret: "k" });
  });
  it("ignores plain addresses and junk", () => {
    expect(parseAgentUrl("127.0.0.1:2419")).toEqual({});
    expect(parseAgentUrl("ws://")).toEqual({});
  });
});
