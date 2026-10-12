import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

// Performance audit: cold start, long-chat scroll smoothness, DOM size. Writes perf.json.
const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true, providers: [], theme: "dark", onboarded: true };

test("performance budget", async ({ page }) => {
  await page.addInitScript((s) => {
    localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  const t0 = Date.now();
  await page.goto(process.env.PERF_URL ?? "/");
  await expect(page.locator(".composer textarea")).toBeEnabled();
  const ready = Date.now() - t0;
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    return { domContentLoaded: Math.round(n.domContentLoadedEventEnd), fcp: Math.round(fcp) };
  });
  await page.locator(".composer textarea").fill("long run");
  await page.locator(".composer textarea").press("Enter");
  await expect(page.locator("[data-virtual]")).toBeVisible();
  await page.waitForTimeout(800);
  const scroll = await page.evaluate(async () => {
    const el = document.querySelector(".messages") as HTMLElement;
    const frames: number[] = [];
    let last = performance.now();
    const start = last;
    el.scrollTop = el.scrollHeight;
    await new Promise<void>((done) => {
      const step = (t: number) => {
        frames.push(t - last);
        last = t;
        el.scrollTop -= 120;
        if (el.scrollTop > 0 && t - start < 4000) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    frames.shift();
    const sorted = [...frames].sort((a, b) => a - b);
    return { frames: frames.length, avgMs: +(frames.reduce((a, b) => a + b, 0) / frames.length).toFixed(1), p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), domNodes: document.querySelectorAll("*").length };
  });
  const result = { readyMs: ready, ...nav, scroll };
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/perf.json", JSON.stringify(result, null, 2));
  console.log("perf", JSON.stringify(result));
  expect(scroll.p95Ms).toBeLessThan(50);
  expect(scroll.domNodes).toBeLessThan(3000);
});
