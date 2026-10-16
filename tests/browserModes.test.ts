// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { cssSelector, designMarkdown, pickName, type Pick } from "../src/browser/picker";
import { DevStore, parseTake, filterLogs, formatNet, takeExpr } from "../src/browser/devlog";
import { cropRect, cssPerPx, fitViewport, parseSize } from "../src/browser/viewport";

describe("selector generation", () => {
  const check = (html: string, pick: string) => {
    document.body.innerHTML = html;
    const el = document.querySelector(pick)!;
    const sel = cssSelector(el);
    expect(document.querySelectorAll(sel).length).toBe(1);
    expect(document.querySelector(sel)).toBe(el);
    return sel;
  };
  it("prefers a unique id, then test ids", () => {
    expect(check(`<button id="go">Go</button>`, "#go")).toBe("#go");
    expect(check(`<div><button data-testid="save">S</button><button>x</button></div>`, "[data-testid=save]")).toBe('button[data-testid="save"]');
  });
  it("uses meaningful classes and nth-of-type for repeated siblings", () => {
    const sel = check(`<ul class="menu"><li class="item">a</li><li class="item">b</li><li class="item">c</li></ul>`, "li:nth-child(2)");
    expect(sel).toContain(":nth-of-type(2)");
  });
  it("skips generated ids and hashed classes", () => {
    const sel = check(`<main><div id="r12345"><span class="css-1x2y3z">a</span><span class="title">b</span></div></main>`, ".css-1x2y3z");
    expect(sel).not.toContain("r12345");
    expect(sel).not.toContain("css-1x2y3z");
  });
  it("anchors on an ancestor id", () => {
    expect(check(`<section id="pricing"><div><a>x</a></div></section><div><a>y</a></div>`, "#pricing a")).toMatch(/^#pricing > /);
  });
  it("survives being injected via toString", () => {
    document.body.innerHTML = `<p><b>one</b><b>two</b></p>`;
    const fn = new Function(`return (${cssSelector.toString()})`)() as typeof cssSelector;
    expect(document.querySelector(fn(document.querySelectorAll("b")[1]))!.textContent).toBe("two");
  });
});

describe("dev log capture parsing", () => {
  it("validates page data", () => {
    expect(parseTake(null)).toBeNull();
    expect(parseTake({ id: 1, logs: [], net: [] })).toBeNull();
    const t = parseTake({ id: "p", seq: 2, logs: [{ seq: 1, t: 5, level: "evil", text: "x".repeat(5000) }, null], net: [{ seq: 2, method: "post", url: "/a", status: "200" }] })!;
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0].level).toBe("log");
    expect(t.logs[0].text).toHaveLength(2000);
    expect(t.net[0]).toMatchObject({ method: "POST", status: 0 });
  });
  it("accumulates across polls and page loads, updating pending requests", () => {
    const s = new DevStore();
    s.merge({ id: "a", seq: 2, logs: [{ seq: 1, t: 1, level: "error", text: "boom" }], net: [{ seq: 2, t: 1, method: "GET", url: "https://x/api", status: 0 }] });
    expect(s.cursor()).toEqual({ logSince: 1, netSince: 1 });
    s.merge({ id: "a", seq: 3, logs: [{ seq: 3, t: 2, level: "warn", text: "hm" }], net: [{ seq: 2, t: 1, method: "GET", url: "https://x/api", status: 404, ms: 12 }] });
    expect(s.net).toHaveLength(1);
    expect(s.net[0].status).toBe(404);
    expect(s.cursor()).toEqual({ logSince: 3, netSince: 2 });
    s.merge({ id: "b", seq: 1, logs: [{ seq: 1, t: 3, level: "log", text: "new page" }], net: [] });
    expect(s.logs.map((l) => l.text)).toEqual(["boom", "hm", "new page"]);
    expect(s.console({ level: "error" }).map((e) => e.text)).toEqual(["boom"]);
    expect(s.console({ since: 2 }).map((e) => e.text)).toEqual(["new page"]);
    expect(s.network({ failed_only: true })).toHaveLength(1);
    expect(filterLogs(s.logs, "warn")).toHaveLength(2);
    expect(formatNet(s.net)).toContain("GET 404 https://x/api 12ms");
    expect(takeExpr(3, 2)).toContain("e.seq > 3");
  });
  it("the injected capture script records console, errors and fetch", async () => {
    const { readFileSync } = await import("node:fs");
    const w = window as any;
    w.fetch = async () => ({ status: 201 });
    new Function(readFileSync("src-tauri/src/browser_init.js", "utf8"))();
    console.warn("careful", { a: 1 });
    await w.fetch("/api/x", { method: "post" });
    window.dispatchEvent(new (window as any).ErrorEvent("error", { message: "kaboom", filename: "app.js", lineno: 3, colno: 4 }));
    const t = parseTake(new Function(`return ${takeExpr(0, 0)}`)())!;
    expect(t.logs.find((l) => l.level === "warn")!.text).toBe('careful {"a":1}');
    expect(t.logs.find((l) => l.kind === "uncaught")).toMatchObject({ text: "kaboom", source: "app.js:3:4" });
    expect(t.net.find((n) => n.url.endsWith("/api/x"))).toMatchObject({ method: "POST", status: 201 });
  });
});

describe("viewport math", () => {
  it("parses sizes", () => {
    expect(parseSize("1600x900")).toEqual({ width: 1600, height: 900 });
    expect(parseSize(" 1920 × 1080 ")).toEqual({ width: 1920, height: 1080 });
    expect(parseSize("10x10")).toBeNull();
    expect(parseSize("abc")).toBeNull();
  });
  it("fits and centers, never upscales", () => {
    const f = fitViewport({ width: 1920, height: 1080 }, { x: 0, y: 48, width: 1360, height: 812 }, 16);
    expect(f.scale).toBeCloseTo(1328 / 1920);
    expect(f.width).toBe(1328);
    expect(f.x).toBe(16);
    expect(f.y).toBe(48 + Math.round((812 - f.height) / 2));
    expect(fitViewport({ width: 800, height: 600 }, { x: 0, y: 0, width: 2000, height: 2000 }).scale).toBe(1);
  });
  it("maps screenshots to CSS px and crops", () => {
    expect(cssPerPx(1920, 1280)).toBe(1.5);
    expect(cropRect({ x: 100, y: 50, width: 200, height: 40 }, 1920, { width: 960, height: 540 }, 0)).toEqual({ x: 50, y: 25, width: 100, height: 20 });
    expect(cropRect({ x: 5000, y: 0, width: 10, height: 10 }, 1920, { width: 960, height: 540 })).toBeNull();
  });
});

describe("design context", () => {
  const p: Pick = { selector: "main > button.primary:nth-of-type(2)", tag: "button", text: "Buy", html: "<button class=\"primary\">Buy</button>", box: { x: 1, y: 2, width: 3, height: 4 }, styles: { "border-radius": "0px" }, source: "src/App.tsx:12", page: { url: "http://localhost:5173/", title: "Shop", width: 1920, height: 1080, scrollY: 0 } };
  it("picker script installs and reports through PICK_TAKE", async () => {
    const { pickerScript, PICK_TAKE, PICK_OFF } = await import("../src/browser/picker");
    expect(new Function(`return ${PICK_TAKE}`)()).toEqual({ missing: true });
    expect(new Function(`return ${pickerScript()}`)()).toBe(true);
    expect(new Function(`return ${PICK_TAKE}`)()).toEqual({ commit: 0, picks: [], exit: false });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(new Function(`return ${PICK_TAKE}`)().exit).toBe(true);
    expect(new Function(`return ${PICK_OFF}`)()).toBe(true);
  });
  it("builds markdown and file names", () => {
    const md = designMarkdown([p]);
    expect(md).toContain("`main > button.primary:nth-of-type(2)`");
    expect(md).toContain("src/App.tsx:12");
    expect(md).toContain("- border-radius: 0px");
    expect(md).toContain("viewport 1920×1080");
    expect(pickName(p, ".md")).toBe("button.primary-2.md");
  });
});
