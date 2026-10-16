import { expect, test } from "@playwright/test";

// Keep runs hermetic: the live release check would open a blocking update banner whenever a newer release is published.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false };
const IDS = ["dark", "midnight", "forest", "ember", "contrast", "light", "paper", "sky", "rose"];

test("every theme applies, from settings and from /theme", async ({ page }) => {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-appearance").click();
  for (const id of IDS) await expect(page.getByTestId(`theme-${id}`)).toBeVisible();
  await page.getByTestId("theme-forest").click();
  await page.getByTestId("settings-save").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
  const box = page.locator(".composer textarea");
  for (const id of IDS) {
    await box.fill(`/theme ${id}`);
    await box.press("Escape");
    await box.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    if (process.env.THEME_SHOTS) await page.screenshot({ path: `${process.env.THEME_SHOTS}/theme-${id}.png` });
  }
});
