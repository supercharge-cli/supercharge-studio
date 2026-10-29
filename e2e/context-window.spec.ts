import { expect, Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

async function boot(page: Page, bind: string) {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
  }, { bind, secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true });
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await page.locator(".composer textarea").fill("hello tokens");
  await page.locator(".composer textarea").press("Enter");
  await expect(page.getByTestId("context-meter")).toHaveAttribute("title", /52,300 \/ 200,000 tokens/);
}

test("context ring opens the window picker; presets and custom go through the context_window config option", async ({ page }) => {
  await boot(page, "127.0.0.1:2421");
  await page.getByTestId("context-meter").click();
  const pop = page.getByTestId("ctx-pop");
  await expect(pop).toContainText("52,300 / 200,000 tokens");
  await expect(pop.getByTestId("ctx-window-select")).toHaveValue("auto");
  await expect(pop.locator("option")).toHaveText(["Auto", "128K", "200K", "256K", "400K", "1M", "2M", "Custom…"]);
  await pop.getByTestId("ctx-window-select").selectOption("1000000");
  await expect(pop).toBeHidden();
  await expect(page.getByTestId("context-meter")).toHaveAttribute("title", /52,300 \/ 1,000,000 tokens/);
  await page.getByTestId("context-meter").click();
  await expect(pop.getByTestId("ctx-window-select")).toHaveValue("1000000");
  await pop.getByTestId("ctx-window-select").selectOption("custom");
  await pop.getByTestId("ctx-window-custom").fill("nope");
  await pop.getByTestId("ctx-window-custom").press("Enter");
  await expect(pop.getByRole("alert")).toContainText("Enter a size");
  await pop.getByTestId("ctx-window-custom").fill("300k");
  await pop.getByTestId("ctx-window-custom").press("Enter");
  await expect(page.getByTestId("context-meter")).toHaveAttribute("title", /52,300 \/ 300,000 tokens/);
});

test("without the config option, the picker falls back to the context_window extension", async ({ page }) => {
  await boot(page, "127.0.0.1:2452");
  await page.getByTestId("context-meter").click();
  const pop = page.getByTestId("ctx-pop");
  await pop.getByTestId("ctx-window-select").selectOption("400000");
  await expect(page.getByTestId("context-meter")).toHaveAttribute("title", /52,300 \/ 400,000 tokens/);
  await page.getByTestId("context-meter").click();
  await expect(pop.getByTestId("ctx-window-select")).toHaveValue("400000");
  await pop.getByTestId("ctx-window-select").selectOption("auto");
  await expect(page.getByTestId("context-meter")).toHaveAttribute("title", /52,300 \/ 200,000 tokens/);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("phone: context ring opens the window picker through the computer", async ({ page }) => {
    const { uri } = await (await fetch("http://127.0.0.1:2431/pair")).json();
    await page.goto("/mobile.html");
    await page.getByTestId("m-name").fill("Pixel Ctx");
    await page.getByTestId("m-code").fill(uri);
    await page.getByTestId("m-pair-btn").click();
    await expect(page.getByTestId("m-status")).toHaveText("open");
    await page.getByTestId("m-chat").first().click();
    // The ring only shows once the session load reports window support; under a busy
    // parallel run that can take longer than the default 5 s, so wait for the load to finish.
    await expect(page.getByTestId("m-thread")).toBeVisible();
    await expect(page.locator(".skel-chat")).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("m-err")).toHaveCount(0);
    const ring = page.getByTestId("context-meter");
    await expect(ring).toBeVisible({ timeout: 15000 });
    await ring.click();
    await page.getByTestId("ctx-window-select").selectOption("1000000");
    await expect(ring).toHaveAttribute("title", /52,300 \/ 1,000,000 tokens/);
  });
});
