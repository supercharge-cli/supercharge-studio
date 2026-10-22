import { describe, expect, it, vi } from "vitest";

describe("bundle trims", () => {
  it("invoke and listen talk to the desktop shell directly", async () => {
    const calls: [string, any][] = [];
    let handler: ((e: { payload: string }) => void) | undefined;
    const unregister = vi.fn();
    (globalThis as any).window = globalThis;
    (globalThis as any).__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => { calls.push([c, a]); return c === "plugin:event|listen" ? 7 : "ok"; }, transformCallback: (f: any) => { handler = f; return 42; } };
    (globalThis as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: unregister };
    const { invoke, listen } = await import("../src/lib/desktop");
    expect(await invoke("x_cmd", { a: 1 })).toBe("ok");
    const got: string[] = [];
    const off = await listen<string>("agent://status", (p) => got.push(p));
    expect(calls[1]).toEqual(["plugin:event|listen", { event: "agent://status", target: { kind: "Any" }, handler: 42 }]);
    handler!({ payload: "ready" });
    expect(got).toEqual(["ready"]);
    off();
    expect(unregister).toHaveBeenCalledWith("agent://status", 7);
    expect(calls.at(-1)).toEqual(["plugin:event|unlisten", { event: "agent://status", eventId: 7 }]);
    delete (globalThis as any).__TAURI_INTERNALS__;
  });
});
