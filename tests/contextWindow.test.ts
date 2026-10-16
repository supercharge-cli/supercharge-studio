import { describe, expect, it, vi } from "vitest";
import { applyWindow, parseWindow, windowLabel, windowOption } from "../src/lib/contextWindow";
import { GatewayHub } from "../src/gateway/hub";

describe("context window", () => {
  it("parses sizes", () => {
    expect(parseWindow("1m")).toBe(1000000);
    expect(parseWindow("400k")).toBe(400000);
    expect(parseWindow("1.5M")).toBe(1500000);
    expect(parseWindow("350,000")).toBe(350000);
    expect(parseWindow("auto")).toBe("auto");
    expect(parseWindow("")).toBe("auto");
    expect(parseWindow("abc")).toBeNull();
    expect(parseWindow("12")).toBeNull();
  });
  it("labels", () => {
    expect(windowLabel("auto")).toBe("Auto");
    expect(windowLabel(1000000)).toBe("1M");
    expect(windowLabel("300000")).toBe("300K");
    expect(windowLabel(1500000)).toBe("1.5M");
  });
  it("finds the option", () => {
    expect(windowOption([{ id: "context_window", name: "x", currentValue: "auto", options: [] } as any])?.id).toBe("context_window");
    expect(windowOption([])).toBeUndefined();
  });
  it("uses the config option, else the extension", async () => {
    const c = { setConfigOption: vi.fn(async () => ({ configOptions: [{ id: "context_window" }] })), ext: vi.fn(async () => ({ contextWindow: 1000000, overridden: true })) };
    expect((await applyWindow(c, "s", 1000000, true)).configOptions).toHaveLength(1);
    expect(c.setConfigOption).toHaveBeenCalledWith("s", "context_window", "1000000");
    expect((await applyWindow(c, "s", "auto", false)).contextWindow).toBe(1000000);
    expect(c.ext).toHaveBeenCalledWith("_supercharge/session/context_window", { sessionId: "s", contextWindow: "auto" });
  });
  it("gateway forwards window changes and reports support", async () => {
    const sent: any[] = [];
    const set = vi.fn(async (_s: string, v: number | "auto") => ({ contextWindow: v === "auto" ? 200000 : v }));
    const hub = new GatewayHub((_d, m) => sent.push(m), {
      sessions: () => [{ sessionId: "s1", title: "t", cwd: "/", project: "p", projectId: "p1", group: "g" }], projects: () => [],
      prompt: async () => ({ stopReason: "end_turn" }), cancel() {}, newSession: async () => "s2", focus() {},
      windowSupport: () => ({ via: "ext" }), setContextWindow: set,
    });
    hub.connected("d");
    await hub.receive("d", { jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s1" } } as any);
    expect(sent.find((m) => m.id === 1).result._meta.supercharge.contextWindow).toEqual({ via: "ext" });
    await hub.receive("d", { jsonrpc: "2.0", id: 2, method: "_supercharge/session/context_window", params: { sessionId: "s1", contextWindow: "1m" } } as any);
    expect(set).toHaveBeenCalledWith("s1", 1000000);
    expect(sent.find((m) => m.id === 2).result).toEqual({ contextWindow: 1000000, overridden: true });
    await hub.receive("d", { jsonrpc: "2.0", id: 3, method: "_supercharge/session/context_window", params: { sessionId: "s1", contextWindow: "big" } } as any);
    expect(sent.find((m) => m.id === 3).error.code).toBe(-32602);
    hub.contextUsage("s1", 10, 1000000);
    expect(sent.at(-1)).toMatchObject({ method: "_supercharge/session/context_usage", params: { sessionId: "s1", usedTokens: 10, maxTokens: 1000000 } });
  });
});
