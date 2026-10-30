import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserController, POINTER_OPS, wrapScript } from "../src/browser/bridge";

const PRE = wrapScript("@@").indexOf("@@");
const expr = (script: string) => script.slice(PRE, -2);

// Fake desktop shell: records invoke calls; browser_eval answers like the page would.
let calls: { cmd: string; args: any }[];
let evalValue: (script: string) => unknown;
beforeEach(() => {
  calls = [];
  evalValue = () => true;
  (globalThis as any).window = globalThis;
  (globalThis as any).matchMedia = () => ({ matches: true }); // reduced motion: no animation wait
  (globalThis as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === "browser_eval") {
        const e = expr(args.script);
        const v = e === "document.readyState" ? "complete" : e.includes("location.href") ? { url: "https://x.test/", title: "" } : evalValue(e);
        return JSON.stringify({ ok: true, value: v });
      }
      return null;
    },
    transformCallback: () => 1,
  };
});
afterEach(() => {
  delete (globalThis as any).__TAURI_INTERNALS__;
  delete (globalThis as any).matchMedia;
});

const open = () => {
  const b = new BrowserController();
  b.bounds = { x: 0, y: 0, width: 800, height: 600 };
  return b;
};

describe("AI cursor", () => {
  it("moves to the action's coordinates (scaled by zoom) before acting", async () => {
    const b = open();
    b.zoom = 0.5;
    await b.run("click", { x: 100, y: 40 });
    const i = calls.findIndex((c) => c.cmd === "browser_cursor");
    expect(calls[i].args).toEqual({ op: "click", x: 50, y: 20 });
    const act = calls.findIndex((c) => c.cmd === "browser_eval" && String(c.args.script).includes("__sc.click"));
    expect(act).toBeGreaterThan(i);
  });

  it("locates ref targets in the page and shows typing / scroll indicators", async () => {
    const b = open();
    evalValue = (s) => (s.includes("getBoundingClientRect(); return [") ? [10, 20] : true);
    await b.run("type", { ref: 3, text: "hi" });
    expect(calls.find((c) => c.cmd === "browser_cursor")!.args).toEqual({ op: "type", x: 10, y: 20 });
    calls = [];
    await b.run("scroll", { dy: 300 });
    expect(calls.find((c) => c.cmd === "browser_cursor")!.args).toEqual({ op: "scroll", x: 400, y: 300 });
  });

  it("logs a failing cursor call and still performs the action", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = (globalThis as any).__TAURI_INTERNALS__.invoke;
    (globalThis as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "browser_cursor") { calls.push({ cmd, args }); throw "browser_cursor not allowed"; }
      return inner(cmd, args);
    };
    try {
      const b = open();
      await b.run("click", { x: 5, y: 5 });
      expect(calls.some((c) => c.cmd === "browser_eval" && String(c.args.script).includes("__sc.click"))).toBe(true);
      expect(warn).toHaveBeenCalledWith("[browser] AI cursor:", "browser_cursor not allowed");
      await b.hideCursor();
      const ops = calls.filter((c) => c.cmd === "browser_cursor").map((c) => c.args.op);
      expect(ops[0]).toBe("click");
      expect(ops.at(-1)).toBe("hide");
      expect(ops.filter((o) => o === "hide")).toHaveLength(1);
      expect(warn.mock.calls.length).toBe(ops.length);
    } finally { warn.mockRestore(); }
  }, 10000);

  it("does not move for non-pointer ops", async () => {
    const b = open();
    await b.run("snapshot", {});
    expect(calls.filter((c) => c.cmd === "browser_cursor").map((c) => c.args.op)).toEqual(["show"]);
    await b.hideCursor();
    expect(calls.filter((c) => c.cmd === "browser_cursor").map((c) => c.args.op)).toEqual(["show", "hide"]);
    expect(Object.keys(POINTER_OPS)).toEqual(["click", "hover", "type", "press_key", "select_option", "scroll"]);
  });

  it("waits while the user has taken over, and continues when handed back", async () => {
    const b = open();
    const seen: boolean[] = [];
    b.onHeld = (h) => seen.push(h);
    b.takeOver(true);
    let done = false;
    const p = b.run("click", { x: 1, y: 1 }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    expect(calls.some((c) => c.cmd === "browser_eval")).toBe(false);
    b.takeOver(false);
    await p;
    expect(done).toBe(true);
    expect(seen).toEqual([true, false]);
  });

  it("layer is a separate native webview the page cannot reach", () => {
    const rs = readFileSync("src-tauri/src/cursor.rs", "utf8");
    const js = readFileSync("src-tauri/src/cursor.js", "utf8");
    const caps = readFileSync("src-tauri/capabilities/default.json", "utf8");
    expect(rs).toMatch(/WebviewBuilder::new\(CURSOR/);
    expect(rs).toMatch(/\.transparent\(true\)/);
    expect(caps).not.toMatch(/browser-cursor/); // no IPC for the layer
    expect(js).not.toMatch(/__TAURI/);
    expect(js).toMatch(/prefers-reduced-motion/);
    expect(js).toMatch(/Supercharge is browsing/);
    // On Linux the layer only shows what keeps repainting (see public/cursor.html).
    const html = readFileSync("public/cursor.html", "utf8");
    expect(html).toMatch(/#c\{[^}]*animation:k [^}]*infinite/);
    expect(html).toMatch(/#l\{[^}]*animation:k [^}]*infinite/);
    expect(html).toMatch(/@keyframes k\{/);
    // The page's own init script never mentions the layer.
    expect(readFileSync("src-tauri/src/browser_init.js", "utf8")).not.toMatch(/cursor/i);
  });
});
