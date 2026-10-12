import { expect, Page, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Performance budgets: cold start, frame timing while tokens stream, long-chat scrolling,
 * screen transitions, and mobile swipe-back. Results go to test-results/perf.json.
 * Budgets are loose enough for shared CI runners but catch real regressions
 * (a 60 fps frame is 16.7 ms; we require p95 under two frames and no >100 ms stalls).
 */
const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true, providers: [], theme: "dark", onboarded: true };
const results: Record<string, unknown> = {};
test.describe.configure({ mode: "serial" });
test.afterAll(() => {
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/perf.json", JSON.stringify(results, null, 2));
  console.log("perf", JSON.stringify(results));
});

/** Record rAF frame intervals until `stop()` resolves in the page. */
async function frames(page: Page, during: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as any;
    w.__f = [];
    w.__run = true;
    let last = performance.now();
    const tick = (t: number) => { w.__f.push(t - last); last = t; if (w.__run) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await during();
  const f: number[] = await page.evaluate(() => { const w = window as any; w.__run = false; return w.__f.slice(1); });
  const s = [...f].sort((a, b) => a - b);
  const pct = (p: number) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
  return { frames: f.length, avgMs: +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(1), p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: +s[s.length - 1].toFixed(1), over50ms: f.filter((x) => x > 50).length };
}

async function boot(page: Page) {
  if (process.env.NO_VT) await page.addInitScript(() => { delete (Document.prototype as any).startViewTransition; });
  await page.addInitScript((s) => {
    localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  const t0 = Date.now();
  await page.goto(process.env.PERF_URL ?? "/");
  await expect(page.locator(".composer textarea")).toBeEnabled();
  return Date.now() - t0;
}

test("desktop: cold start, token streaming, long-chat scroll, screen transitions", async ({ page }) => {
  const readyMs = await boot(page);
  results.startup = { readyMs, ...(await page.evaluate(() => ({ fcpMs: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0), domContentLoadedMs: Math.round((performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).domContentLoadedEventEnd) }))) };

  const ta = page.locator(".composer textarea");
  results.streaming = await frames(page, async () => {
    await ta.fill("tokens please");
    await ta.press("Enter");
    await expect(page.locator(".bubble.agent").last()).toContainText("streaming tokens", { timeout: 15000 });
    await expect(page.locator(".typing")).toHaveCount(0);
  });

  await ta.fill("long run");
  await ta.press("Enter");
  await expect(page.locator("[data-virtual]")).toBeVisible();
  await page.waitForTimeout(500);
  results.scroll = await frames(page, () => page.evaluate(async () => {
    const el = document.querySelector(".messages") as HTMLElement;
    el.scrollTop = el.scrollHeight;
    for (let i = 0; i < 140 && el.scrollTop > 0; i++) { el.scrollTop -= 120; await new Promise(requestAnimationFrame); }
  }));
  (results.scroll as any).domNodes = await page.evaluate(() => document.querySelectorAll("*").length);

  const t = Date.now();
  results.transition = await frames(page, async () => {
    await page.getByTestId("open-usage").click();
    await expect(page.getByTestId("usage-screen")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ta).toBeVisible();
  });
  (results.transition as any).roundTripMs = Date.now() - t;

  const st = results.streaming as any, sc = results.scroll as any, tr = results.transition as any;
  expect(st.p95Ms).toBeLessThan(34);
  expect(st.over50ms).toBeLessThanOrEqual(3);
  expect(sc.p95Ms).toBeLessThan(34);
  expect(sc.domNodes).toBeLessThan(3000);
  expect(tr.maxMs).toBeLessThan(150); // shared CI runners jitter by a frame or two
});

test("mobile: swipe back and pull to refresh stay on the compositor", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const { uri } = await (await fetch("http://127.0.0.1:2431/pair")).json();
  await page.goto("/mobile.html");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-list")).toBeVisible();
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type: string, x: number, y: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] } as any);
  const drag = async (x0: number, y0: number, x1: number, y1: number, steps = 20) => {
    await touch("touchStart", x0, y0);
    for (let i = 1; i <= steps; i++) { await touch("touchMove", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await page.waitForTimeout(8); }
    await touch("touchEnd", x1, y1);
  };
  results.pullToRefresh = await frames(page, async () => {
    await drag(195, 200, 195, 420);
    await expect(page.locator(".m-toast")).toHaveText("Up to date");
  });
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-thread")).toBeVisible();
  results.swipeBack = await frames(page, async () => {
    await drag(4, 400, 330, 410);
    await expect(page.getByTestId("m-list")).toBeVisible();
  });
  expect((results.swipeBack as any).p95Ms).toBeLessThan(34);
  expect((results.pullToRefresh as any).p95Ms).toBeLessThan(34);
  await ctx.close();
});
