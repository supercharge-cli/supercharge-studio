import { describe, expect, it } from "vitest";
import { acpServers, splitArgs } from "../src/lib/mcpServers";

describe("MCP server manager", () => {
  it("builds ACP mcpServers entries", () => {
    const list = [
      { name: "fs", on: true, command: "npx", args: `-y server-fs "/my dir"`, env: "TOKEN=a=b\nbad" },
      { name: "web", on: true, url: "https://mcp.example.test/mcp", env: "Authorization: Bearer x" },
      { name: "off", on: false, command: "x" },
      { name: "", on: true, command: "x" },
    ];
    expect(acpServers(list, true)).toEqual([
      { name: "fs", command: "npx", args: ["-y", "server-fs", "/my dir"], env: [{ name: "TOKEN", value: "a=b" }] },
      { type: "http", name: "web", url: "https://mcp.example.test/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] },
    ]);
    expect(acpServers(list, false)).toHaveLength(1);
    expect(acpServers(undefined, true)).toEqual([]);
    expect(splitArgs(`a 'b c' "d"`)).toEqual(["a", "b c", "d"]);
  });
});
