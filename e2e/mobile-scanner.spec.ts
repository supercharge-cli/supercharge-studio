import { expect, test, type Page } from "@playwright/test";
import { shotPath } from "./shot";

const GW = "http://127.0.0.1:2431";
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" });

type Cam = { perm?: "granted" | "prompt" | "denied"; grant?: "granted" | "denied"; noCamera?: boolean };

/**
 * Stand in for the phone shell: a fake Tauri IPC whose barcode-scanner `scan` stays pending until the test
 * answers it, and a fake camera feed (a laptop showing a QR code) that shows through the transparent page.
 */
async function phone(page: Page, cam: Cam = {}) {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
  await page.addInitScript((cam: Cam) => {
    const w = window as any;
    w.__calls = [];
    let cb = 0;
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => ++cb,
      invoke: (cmd: string, args: unknown) => {
        w.__calls.push(cmd);
        const bs = cmd.replace("plugin:barcode-scanner|", "");
        if (bs === "check_permissions") return Promise.resolve({ camera: cam.perm ?? "granted" });
        if (bs === "request_permissions") return Promise.resolve({ camera: cam.grant ?? "granted" });
        if (bs === "scan") { w.__scanArgs = args; return new Promise((res, rej) => { w.__scan = { res, rej }; }); }
        if (bs === "cancel") { w.__scan?.rej("cancelled"); return Promise.resolve(null); }
        return Promise.resolve(null);
      },
    };
    const devices = cam.noCamera ? [{ kind: "audioinput" }] : [{ kind: "videoinput" }, { kind: "audioinput" }];
    Object.defineProperty(navigator, "mediaDevices", { value: { enumerateDevices: async () => devices }, configurable: true });
    // Deterministic QR-looking code on a laptop screen, as the camera would see it.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const n = 25, mods: string[] = [];
    const finder = (x: number, y: number) => x < 7 && y < 7 || x >= n - 7 && y < 7 || x < 7 && y >= n - 7;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let on = rnd() > 0.5;
      for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
        if (x >= fx && x < fx + 7 && y >= fy && y < fy + 7) { const d = Math.max(Math.abs(x - fx - 3), Math.abs(y - fy - 3)); on = d !== 2; }
      }
      if (!finder(x, y) && (x === 7 || y === 7 || x === n - 8 || y === n - 8)) on = false;
      if (on) mods.push(`M${x} ${y}h1v1h-1z`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 844" preserveAspectRatio="xMidYMid slice">
      <defs><radialGradient id="r" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#3a3f4a"/><stop offset="1" stop-color="#0d0e12"/></radialGradient>
      <linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#262a33"/><stop offset="1" stop-color="#16181d"/></linearGradient></defs>
      <rect width="390" height="844" fill="url(#r)"/>
      <g transform="translate(195 300) rotate(-4)"><rect x="-200" y="-150" width="400" height="290" rx="14" fill="#08090b"/>
      <rect x="-188" y="-138" width="376" height="262" rx="4" fill="url(#s)"/>
      <rect x="-80" y="-102" width="160" height="160" rx="6" fill="#f4f4f6"/>
      <g transform="translate(-68 -90) scale(5.44)"><path d="${mods.join("")}" fill="#111"/></g>
      <rect x="-60" y="72" width="120" height="7" rx="3.5" fill="#5a5f6b"/><rect x="-40" y="88" width="80" height="5" rx="2.5" fill="#3d414a"/></g>
      <rect x="-20" y="560" width="430" height="300" fill="#1c1d21" opacity=".9"/></svg>`;
    addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "#fake-cam{position:fixed;inset:0;z-index:-1;background:center/cover no-repeat}html:not(.m-cam) #fake-cam{display:none}";
      const d = document.createElement("div");
      d.id = "fake-cam";
      d.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
      document.documentElement.append(s, d);
    });
  }, cam);
  await page.goto("/mobile.html");
  await expect(page.getByTestId("m-pair")).toBeVisible();
}

const scanner = (page: Page) => page.getByTestId("m-scanner");
const answer = (page: Page, text: string) => page.evaluate((t) => (window as any).__scan.res({ content: t, format: "QR_CODE" }), text);
const pairUri = async () => (await (await fetch(`${GW}/pair`)).json()).uri as string;
/** A well-formed pairing code whose computer never answers, so the sheet stays on "connecting". */
const silentUri = async () => (await pairUri()).replace(/u=[^&]+/, `u=${encodeURIComponent("ws://10.255.255.1:2420")}`);

test("scans a pairing QR, shows success, links up and pairs", async ({ page }) => {
  await phone(page);
  await page.getByTestId("m-scan").click();
  await expect(scanner(page)).toHaveClass(/s-scan/);
  await expect(page.locator("html")).toHaveClass(/m-cam/);
  await expect(page.locator(".m-scan-line")).toBeVisible();
  await expect(page.locator(".m-scan-frame i")).toHaveCount(4);
  await expect(page.getByTestId("m-scan-sub")).toHaveText("Hold steady and fill the square");
  expect(await page.evaluate(() => (window as any).__scanArgs)).toEqual({ windowed: true, formats: ["QR_CODE"] });
  // The page behind the sheet is hidden so only the camera shows through the window.
  await expect(page.getByTestId("m-code")).toBeHidden();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shotPath("scanner-1-scanning.png") });

  await answer(page, await pairUri());
  await expect(scanner(page)).toHaveClass(/s-(ok|link)/);
  await expect(page.locator("html")).not.toHaveClass(/m-cam/);
  await expect(page.getByTestId("m-list")).toBeVisible();
  await expect(page.getByTestId("m-status")).toHaveText("open");
  await expect(scanner(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__calls)).toContain("plugin:barcode-scanner|check_permissions");
});

test("success snaps the frame to the success colour, then shows the connecting state", async ({ page }) => {
  await phone(page);
  await page.clock.install();
  await page.getByTestId("m-scan").click();
  await expect(scanner(page)).toHaveClass(/s-scan/);
  // Hold the success beat (app timers only; CSS keeps animating) to capture it.
  await page.clock.pauseAt(Date.now() + 60_000);
  await answer(page, await silentUri());
  await expect(scanner(page)).toHaveClass(/s-ok/);
  await expect(page.getByTestId("m-scan-sub")).toHaveText("Code found");
  await expect(page.locator(".m-scan-ok")).toBeVisible();
  await page.waitForTimeout(700);
  const ok = await page.locator(".m-scan-frame").evaluate((el) => getComputedStyle(el).color);
  const want = await page.evaluate(() => { const p = document.createElement("i"); p.style.color = "var(--ok)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
  expect(ok).toBe(want);
  await page.screenshot({ path: shotPath("scanner-2-success.png") });

  await page.clock.resume();
  await expect(scanner(page)).toHaveClass(/s-link/);
  await expect(page.locator("h2", { hasText: "Pairing" })).toBeVisible();
  await expect(page.getByTestId("m-scan-sub")).toHaveText("Connecting to Test Desktop…");
  await expect(page.locator(".m-link.on")).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath("scanner-3-connecting.png") });
});

test("camera permission denied explains why and offers settings or pasting the link", async ({ page }) => {
  await phone(page, { perm: "prompt", grant: "denied" });
  await page.getByTestId("m-scan").click();
  await expect(scanner(page)).toHaveClass(/s-denied/);
  await expect(page.getByTestId("m-scan-sub")).toHaveText("Camera access is off");
  await expect(scanner(page)).toContainText("Allow the camera");
  await expect(page.locator(".m-scan-line")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveClass(/m-cam/);
  const calls = await page.evaluate(() => (window as any).__calls as string[]);
  expect(calls).toContain("plugin:barcode-scanner|request_permissions");
  expect(calls).not.toContain("plugin:barcode-scanner|scan");
  await page.waitForTimeout(500);
  await page.screenshot({ path: shotPath("scanner-4-permission-denied.png") });

  await page.getByTestId("m-scan-settings").click();
  expect(await page.evaluate(() => (window as any).__calls)).toContain("plugin:barcode-scanner|open_app_settings");
  await page.getByTestId("m-scan-paste").click();
  await expect(scanner(page)).toHaveCount(0);
  await expect(page.getByTestId("m-code")).toBeFocused();
});

test("a phone without a camera goes straight to pasting the link", async ({ page }) => {
  await phone(page, { noCamera: true });
  await page.getByTestId("m-scan").click();
  await expect(scanner(page)).toHaveClass(/s-nocam/);
  await expect(scanner(page)).toContainText("No camera on this device");
  await expect(page.getByTestId("m-scan-settings")).toHaveCount(0);
  await expect(page.getByTestId("m-scan-paste")).toBeVisible();
  // Nothing reached the camera plugin (the deep-link listener still subscribes as usual).
  const calls = await page.evaluate(() => (window as any).__calls as string[]);
  expect(calls.filter((c) => c.includes("barcode-scanner"))).toEqual([]);
  expect(calls).toContain("plugin:event|listen");
  await page.waitForTimeout(500);
  await page.screenshot({ path: shotPath("scanner-5-no-camera.png") });
});

test("another QR code asks to scan again; cancel and close shut the camera", async ({ page }) => {
  await phone(page);
  await page.getByTestId("m-scan").click();
  await expect(scanner(page)).toHaveClass(/s-scan/);
  await answer(page, "WIFI:S:home;T:WPA;P:secret;;");
  await expect(scanner(page)).toHaveClass(/s-bad/);
  await expect(scanner(page)).toContainText("That's a different QR code");
  await page.waitForTimeout(500);
  await page.screenshot({ path: shotPath("scanner-6-wrong-code.png") });

  await page.getByTestId("m-scan-retry").click();
  await expect(scanner(page)).toHaveClass(/s-scan/);
  await page.getByTestId("m-scan-cancel").click();
  await expect(scanner(page)).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveClass(/m-cam/);
  expect(await page.evaluate(() => (window as any).__calls)).toContain("plugin:barcode-scanner|cancel");

  await page.getByTestId("m-scan").click();
  await expect(scanner(page)).toHaveClass(/s-scan/);
  await page.getByTestId("m-scan-close").click();
  await expect(scanner(page)).toHaveCount(0);
  await expect(page.getByTestId("m-code")).toBeVisible();
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("drops the sweeping line and moves on right away", async ({ page }) => {
    await phone(page);
    await page.getByTestId("m-scan").click();
    await expect(scanner(page)).toHaveClass(/s-scan/);
    await expect(page.locator(".m-scan-line")).toBeHidden();
    expect(await page.locator(".m-scan-frame").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    await answer(page, await silentUri());
    await expect(scanner(page)).toHaveClass(/s-link/);
  });
});
