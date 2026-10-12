/**
 * Live check of the mobile UI against the real desktop gateway.
 *   npx vite --port 5174 &   # serves mobile.html
 *   npx vite-node scripts/live-mobile.ts -- "<pairing code>" [prompt]
 * Approve the pairing on the desktop when asked. Screenshots go to $SHOTS (default /tmp).
 */
import { chromium } from "@playwright/test";

const args = process.argv.slice(2).filter((a) => a !== "--");
const code = args[0];
const prompt = args[1] ?? "Reply with exactly: hello from the phone";
const shots = process.env.SHOTS ?? "/tmp";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
console.log("browser up");
await page.goto("http://127.0.0.1:5174/mobile.html");
console.log("page loaded");
await page.getByTestId("m-name").fill("Pixel (live test)");
await page.getByTestId("m-code").fill(code);
await page.getByTestId("m-pair-btn").click();
console.log("pairing… approve on the desktop");
await page.getByTestId("m-list").waitFor({ timeout: 130000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${shots}/m-list.png` });
console.log("paired; sessions:", await page.getByTestId("m-chat").count());
await page.getByTestId("m-new").first().click();
await page.getByTestId("m-input").waitFor();
await page.getByTestId("m-input").fill(prompt);
await page.getByTestId("m-send").click();
const t0 = Date.now();
await page.waitForFunction(() => document.querySelectorAll(".bubble.agent").length > 0 && !document.querySelector(".typing"), null, { timeout: 120000 });
console.log("reply:", (await page.locator(".bubble.agent").last().innerText()).slice(0, 200), `(${Date.now() - t0} ms)`);
await page.screenshot({ path: `${shots}/m-chat.png` });
if (process.env.PERM_PROMPT) {
  await page.getByTestId("m-input").fill(process.env.PERM_PROMPT);
  await page.getByTestId("m-send").click();
  await page.getByTestId("m-perm").waitFor({ timeout: 90000 });
  await page.screenshot({ path: `${shots}/m-perm.png` });
  console.log("permission:", await page.getByTestId("m-perm").innerText());
  await page.getByTestId("m-perm").getByRole("button").first().click();
  await page.waitForFunction(() => !document.querySelector(".typing"), null, { timeout: 120000 });
  console.log("after permission:", (await page.locator(".bubble.agent").last().innerText()).slice(0, 200));
  await page.screenshot({ path: `${shots}/m-perm-done.png` });
}
await browser.close();
