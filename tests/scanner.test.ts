import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buzz, cameraReady, scanOnce, stopScan } from "../src/mobile/scan";
import { scanCopy, type ScanState } from "../src/mobile/scanner";

type Call = [string, unknown];
let calls: Call[];
let reply: (cmd: string, args: unknown) => unknown;
beforeEach(() => {
  calls = [];
  reply = () => null;
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: async (cmd: string, args: unknown) => { calls.push([cmd, args]); return reply(cmd, args); } } });
  vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => [{ kind: "videoinput" }] } });
});
afterEach(() => vi.unstubAllGlobals());
const cmds = () => calls.map((c) => c[0].replace("plugin:barcode-scanner|", ""));

describe("scanner copy", () => {
  const all: ScanState[] = ["start", "scan", "ok", "link", "denied", "nocam", "bad", "err"];
  it("has a subtitle for every state and a panel for every non-live one", () => {
    for (const s of all) {
      const [sub, title, text] = scanCopy(s);
      expect(sub).toBeTruthy();
      expect(!!title && !!text).toBe(!["start", "scan", "ok"].includes(s));
    }
  });
  it("names the computer while linking, and asks for approval while waiting", () => {
    expect(scanCopy("link", "Studio PC")[0]).toBe("Connecting to Studio PC…");
    expect(scanCopy("link")[0]).toBe("Connecting to your computer…");
    expect(scanCopy("link", "Studio PC", true)).toEqual(["Approve this phone on Studio PC", "Almost there", "Confirm the request in Supercharge Studio on Studio PC."]);
  });
  it("offers the paste fallback when the camera can't be used", () => {
    for (const s of ["denied", "nocam", "err"] as const) expect(scanCopy(s)[2]).toMatch(/paste the pairing link/i);
  });
});

describe("camera readiness", () => {
  it("is ready when permission is already granted, without prompting", async () => {
    reply = (c) => (c.endsWith("check_permissions") ? { camera: "granted" } : null);
    expect(await cameraReady()).toBe("ok");
    expect(cmds()).toEqual(["check_permissions"]);
  });
  it("asks once when the permission is still open", async () => {
    reply = (c) => ({ camera: c.endsWith("request_permissions") ? "granted" : "prompt" });
    expect(await cameraReady()).toBe("ok");
    expect(cmds()).toEqual(["check_permissions", "request_permissions"]);
  });
  it("reports a refused permission or a failing plugin as denied", async () => {
    reply = () => ({ camera: "denied" });
    expect(await cameraReady()).toBe("denied");
    reply = () => { throw new Error("no plugin"); };
    expect(await cameraReady()).toBe("denied");
  });
  it("reports a phone without a camera before touching the plugin", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => [{ kind: "audioinput" }] } });
    expect(await cameraReady()).toBe("nocam");
    expect(calls).toEqual([]);
  });
  it("still tries the plugin when devices can't be listed", async () => {
    vi.stubGlobal("navigator", {});
    reply = () => ({ camera: "granted" });
    expect(await cameraReady()).toBe("ok");
  });
});

describe("scanning", () => {
  it("scans QR codes in a windowed camera view and returns the text", async () => {
    reply = () => ({ content: "scstudio://pair?x", format: "QR_CODE" });
    expect(await scanOnce()).toBe("scstudio://pair?x");
    expect(calls).toEqual([["plugin:barcode-scanner|scan", { windowed: true, formats: ["QR_CODE"] }]]);
  });
  it("returns null when cancelled and tears the view down", async () => {
    reply = (c) => { if (c.endsWith("scan")) throw "cancelled"; return null; };
    expect(await scanOnce()).toBeNull();
    expect(cmds()).toContain("cancel");
  });
  it("rethrows other native errors after tearing down", async () => {
    reply = (c) => { if (c.endsWith("scan")) throw new Error("camera busy"); return null; };
    await expect(scanOnce()).rejects.toThrow("camera busy");
    expect(cmds()).toContain("cancel");
  });
  it("never throws from stop or the haptic tick", async () => {
    reply = () => { throw new Error("gone"); };
    await expect(stopScan()).resolves.toBeUndefined();
    expect(() => buzz()).not.toThrow();
    await Promise.resolve();
    expect(cmds()).toContain("vibrate");
  });
  it("prefers the web vibration API when it exists", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate });
    buzz();
    expect(vibrate).toHaveBeenCalledWith(30);
    expect(calls).toEqual([]);
  });
});
