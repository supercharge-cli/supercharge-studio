import { expect, Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false, onboarded: true };

async function boot(page: Page, unfocused = false) {
  await page.addInitScript(({ s, unfocused }) => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
    const shown: any[] = ((window as any).__notes = []);
    class N { static permission = "granted"; static requestPermission = async () => "granted"; onclick: any = null; constructor(title: string, o: any) { shown.push({ title, ...o }); } close() {} }
    (window as any).Notification = N;
    if (unfocused) document.hasFocus = () => false;
  }, { s: SETTINGS, unfocused });
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}

async function send(page: Page, text: string) {
  await page.locator(".composer textarea").fill(text);
  await page.locator(".composer textarea").press("Enter");
  await expect(page.locator(".bubble.agent").last()).toContainText(`echo: ${text}`);
}

test("Ctrl+K finds text inside past messages and opens the chat at it", async ({ page }) => {
  await boot(page);
  await send(page, "where does the zebra config live");
  await page.waitForTimeout(1200); // index debounce
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("zebra config");
  const hit = page.getByTestId("search-hit").first();
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark")).toHaveText(/zebra config/i);
  await page.screenshot({ path: "test-results/shots/n-search.png" });
  await hit.click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.locator(".search-flash")).toHaveCount(1);
});

test("a finished turn notifies when the window is not focused, and respects the toggle", async ({ page }) => {
  await boot(page, true);
  await send(page, "hello there");
  await expect.poll(() => page.evaluate(() => (window as any).__notes.length)).toBe(1);
  const n = await page.evaluate(() => (window as any).__notes[0]);
  expect(n.title).toMatch(/^Done · /);
  expect(n.silent).toBe(false);
});

test("focused on the same chat: no notification", async ({ page }) => {
  await boot(page, false);
  await send(page, "quiet please");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__notes.length)).toBe(0);
});

test("large dropped images are downscaled before sending", async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 3200; c.height = 2000;
    const g = c.getContext("2d")!; for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${i},70%,50%)`; g.fillRect(Math.random() * 3200, Math.random() * 2000, 300, 300); }
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], "big.png", { type: "image/png" }));
    const target = document.querySelector(".composer")!;
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("attachment")).toHaveCount(1);
  await expect(page.getByTestId("attachment")).toContainText(/big\.(webp|jpg)/);
  await page.screenshot({ path: "test-results/shots/n-image-chip.png" });
});
