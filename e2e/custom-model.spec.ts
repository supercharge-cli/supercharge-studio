import { expect, test, type Page } from "@playwright/test";
import { shotPath } from "./shot";

// Keep runs hermetic: the live release check would open a blocking update banner whenever a newer release is published.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

// CLI fake on 2452 advertises `_supercharge/setup/*` so typed ids go through setup/save.
const SETTINGS = { bind: "127.0.0.1:2452", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true };

async function boot(page: Page) {
  await page.addInitScript((s) => {
    localStorage.setItem(
      "supercharge-studio/v1",
      JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }),
    );
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}

test("composer: type a custom model id, persist it, and show it in the picker", async ({ page }) => {
  await boot(page);
  await page.getByTestId("new-chat").first().click();
  await page.locator(".composer textarea").fill("hi");
  await page.locator(".composer textarea").press("Enter");
  await expect(page.getByTestId("model-trigger")).toBeVisible();
  await page.getByTestId("model-trigger").click();
  await expect(page.getByTestId("model-picker")).toBeVisible();
  await page.getByTestId("model-custom-toggle").click();
  await expect(page.getByTestId("model-custom-form")).toBeVisible();
  await page.getByTestId("model-custom-id").fill("vendor/custom-e2e");
  await page.getByTestId("model-custom-name").fill("Custom E2E");
  await page.screenshot({ path: shotPath("custom-model-form.png") });
  await page.getByTestId("model-custom-save").click();
  await expect(page.getByTestId("model-trigger")).toContainText("Custom E2E");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("supercharge-studio/v1")!).settings.customModels);
  expect(saved).toEqual([{ id: "vendor/custom-e2e", name: "Custom E2E" }]);
  await page.getByTestId("model-trigger").click();
  await expect(page.getByTestId("model-choice").filter({ hasText: "Custom E2E" })).toBeVisible();
  await page.screenshot({ path: shotPath("custom-model-picker.png") });
});

test("composer: empty search still offers typing a model id", async ({ page }) => {
  await boot(page);
  await page.getByTestId("new-chat").first().click();
  await page.locator(".composer textarea").fill("hi again");
  await page.locator(".composer textarea").press("Enter");
  await page.getByTestId("model-trigger").click();
  await page.getByTestId("model-search").fill("zzz-no-match");
  await expect(page.getByText("No matches")).toBeVisible();
  await expect(page.getByTestId("model-custom-toggle")).toBeVisible();
});
