import { describe, expect, it } from "vitest";
import { AcpClient, AcpRpcError } from "../src/acp/client";
import { legacyName, memoryMode } from "../src/acp/legacyNames";

describe("memory ACP names (CLI 1.3.47)", () => {
  it("calls the _supercharge/memory name and falls back to the pre-rename name on method-not-found", async () => {
    const calls: string[] = [];
    const c = new AcpClient({ url: "ws://127.0.0.1:1" } as any);
    const old = legacyName("_supercharge/memory/flush");
    (c as any).request = async (m: string) => { calls.push(m); if (m.startsWith("_supercharge/")) throw new AcpRpcError(-32601, "Method not found"); return { ok: 1 }; };
    expect(await c.memory("flush", { session_id: "s" })).toEqual({ ok: 1 });
    expect(calls).toEqual(["_supercharge/memory/flush", old]);
    calls.length = 0;
    (c as any).request = async (m: string) => { calls.push(m); return { outcome: "completed" }; };
    expect(await c.memory("dream", { session_id: "s" })).toEqual({ outcome: "completed" });
    expect(calls).toEqual(["_supercharge/memory/dream"]);
    (c as any).request = async () => { throw new AcpRpcError(-32602, "unknown session id"); };
    await expect(c.memory("dream", {})).rejects.toThrow("unknown session id");
  });
  it("reads memoryMode from the new meta key, then the old one", () => {
    expect(memoryMode({ "_supercharge/memoryMode": "v2", [legacyName("memoryMode", true)]: "legacy" })).toBe("v2");
    expect(memoryMode({ [legacyName("memoryMode", true)]: "legacy" })).toBe("legacy");
    expect(memoryMode(undefined)).toBeUndefined();
  });
});
