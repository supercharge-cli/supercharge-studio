import { describe, expect, it } from "vitest";
import { pluginTarget, unwrapPluginResult } from "../src/lib/plugins";

describe("plugin management boundary", () => {
  it("requires encrypted remote transport and removes keys from target labels", () => {
    expect(pluginTarget("ws://remote.example/ws", false).secure).toBe(false);
    expect(pluginTarget("wss://remote.example/ws?server-key=secret", false)).toEqual({ label: "wss://remote.example/ws", secure: true });
    expect(pluginTarget("127.0.0.1:2419", false).secure).toBe(true);
    expect(pluginTarget("ws://127.0.0.1.evil.example/ws", false).secure).toBe(false);
    expect(pluginTarget("", true).secure).toBe(true);
    expect(pluginTarget("https://remote.example", false).secure).toBe(false);
  });
  it("does not mistake transport success for operation success", () => {
    expect(unwrapPluginResult({ result: { status: "success", requiresReload: true } }).requiresReload).toBe(true);
    expect(() => unwrapPluginResult({ result: null, error: "Permission denied" })).toThrow("Permission denied");
    expect(() => unwrapPluginResult({ result: { status: "validation_error", message: "Review permissions" } })).toThrow("Review permissions");
    expect(unwrapPluginResult({ result: { status: "pending" } }).status).toBe("pending");
  });
});
