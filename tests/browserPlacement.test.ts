import { afterEach, describe, expect, it } from "vitest";
import { BrowserController, nativeBounds } from "../src/browser/bridge";

// The native side converts CSS px × devicePixelRatio to physical pixels (src-tauri/src/place_math.rs,
// with its own Rust tests). These lock that every bounds the UI sends carries the ratio.
const g = globalThis as any;
afterEach(() => { delete g.window; delete g.devicePixelRatio; });

function desktop(dpr: number) {
  const calls: { cmd: string; args: any }[] = [];
  g.devicePixelRatio = dpr;
  g.window = { __TAURI_INTERNALS__: { invoke: async (cmd: string, args: any) => { calls.push({ cmd, args }); return null; } } };
  return calls;
}

describe("side browser placement", () => {
  it("adds the UI's devicePixelRatio to the slot rect", () => {
    g.devicePixelRatio = 1.25;
    expect(nativeBounds({ x: 637, y: 135, width: 387, height: 410 })).toEqual({ x: 637, y: 135, width: 387, height: 410, scale: 1.25 });
    g.devicePixelRatio = 0;
    expect(nativeBounds({ x: 1, y: 2, width: 3, height: 4 }).scale).toBe(1);
  });

  it("sends the ratio on open, move and navigate, read at send time (a DPI change in between is picked up)", async () => {
    const calls = desktop(1.25);
    const b = new BrowserController();
    const r = { x: 637, y: 135, width: 387, height: 410 };
    await b.open("http://localhost:3000/", r);
    expect(calls.at(-1)).toEqual({ cmd: "browser_open", args: { url: "http://localhost:3000/", bounds: { ...r, scale: 1.25 } } });
    g.devicePixelRatio = 1.5;
    await b.setBounds({ ...r, width: 400 });
    expect(calls.at(-1)).toEqual({ cmd: "browser_set_bounds", args: { bounds: { ...r, width: 400, scale: 1.5 } } });
    // The controller keeps CSS px only; the ratio is never baked into its remembered rect.
    expect(b.bounds).toEqual({ ...r, width: 400 });
  });
});
