import { expect, test, type Page } from "@playwright/test";

// Keep runs hermetic: the live release check would open a blocking update banner whenever a newer release is published.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});
test.describe.configure({ mode: "serial" });

const SETTINGS = { bind: "127.0.0.1:2452", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true };
const OUT = process.env.AUTH_SHOTS;
const shot = async (page: Page, name: string) => { if (OUT) { await page.waitForTimeout(450); await page.screenshot({ path: `${OUT}/auth-${name}.png` }); } };

async function openSetup(page: Page) {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1")) localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [], onboarded: true }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-providers").click();
  await expect(page.getByTestId("provider-setup")).toBeVisible();
}

test("desktop: every /setup provider, filter, API key flow with masked key and custom model", async ({ page }) => {
  await openSetup(page);
  const rows = page.locator('[data-testid^="setup-p-"]');
  await expect(rows).toHaveCount(21);
  await expect(rows.first()).toContainText("Pollinations");
  await expect(rows.first()).toContainText("Recommended — large free/cheap model list");
  await expect(rows.last()).toHaveText("Custom / paste a base URL");
  await shot(page, "providers");

  await page.getByTestId("setup-filter").fill("groq");
  await expect(rows).toHaveCount(1);
  await page.getByTestId("setup-filter").press("Enter");
  // API format step, preselected with the provider's format.
  await expect(page.getByTestId("setup-f-chat_completions")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("setup-f-chat_completions").click();
  const key = page.getByTestId("setup-key");
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("bad");
  await page.getByTestId("setup-reveal").click();
  await expect(key).toHaveAttribute("type", "text");
  await page.getByTestId("setup-reveal").click();
  await expect(key).toHaveAttribute("type", "password");
  await shot(page, "api-key");
  await page.getByTestId("setup-fetch").click();
  await expect(page.getByTestId("setup-error")).toContainText("HTTP 401");
  await page.getByTestId("setup-back").click();
  await key.fill("gsk-good");
  await page.getByTestId("setup-fetch").click();
  await expect(page.getByTestId("setup-model")).toHaveCount(4);
  await shot(page, "models");
  await page.getByTestId("setup-model-filter").fill("type");
  await page.getByTestId("setup-model").click();
  await expect(page.getByTestId("setup-custom-model")).toHaveValue("llama-3.3-70b-versatile");
  await page.getByTestId("setup-custom-model").fill("my-model");
  await page.getByTestId("setup-save").click();
  await expect(page.getByTestId("setup-done")).toContainText("my-model");
});

test("desktop: custom base URL asks for the URL, then format, key optional", async ({ page }) => {
  await openSetup(page);
  await expect(page.getByTestId("setup-current")).toContainText("Groq · my-model");
  await page.getByTestId("setup-p-custom").click();
  await page.getByTestId("setup-url").fill("http://127.0.0.1:8080/v1");
  await page.getByTestId("setup-next").click();
  await page.getByTestId("setup-f-responses").click();
  await expect(page.getByTestId("setup-key")).toHaveAttribute("placeholder", "Optional");
  await page.getByTestId("setup-fetch").click();
  await page.getByTestId("setup-model").first().click();
  await expect(page.getByTestId("setup-done")).toContainText("model-a");
});

test("desktop: Nous Research signs in with a device code, then picks a model", async ({ page }) => {
  await page.addInitScript(() => { (window as any).opened = []; window.open = ((u: string) => { (window as any).opened.push(u); return null; }) as any; });
  await openSetup(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("setup-filter").fill("nous");
  await page.getByTestId("setup-p-nous").click();
  await expect(page.getByTestId("setup-code")).toHaveText("WDJB-MJHT");
  await expect(page.getByTestId("setup-device-url")).toHaveText(/portal\.nousresearch\.com\/oauth\/device/);
  await expect.poll(() => page.evaluate(() => (window as any).opened.length)).toBe(1);
  await page.getByTestId("setup-copy-code").click();
  await expect(page.getByTestId("setup-copy-code")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("WDJB-MJHT");
  await shot(page, "device-code");
  // Two polls (1 s apart): pending, then approved → models.
  await expect(page.getByTestId("setup-model").first()).toBeVisible({ timeout: 8000 });
  await page.getByTestId("setup-model").nth(1).click();
  await expect(page.getByTestId("setup-done")).toContainText("model-b");
  await shot(page, "saved");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("sets up a provider on the paired computer, including the Nous code login", async ({ page }) => {
    await page.addInitScript(() => { (window as any).opened = []; window.open = ((u: string) => { (window as any).opened.push(u); return null; }) as any; });
    const { uri } = await (await fetch("http://127.0.0.1:2431/pair")).json();
    await page.goto("/mobile.html");
    await page.getByTestId("m-name").fill("Pixel Setup");
    await page.getByTestId("m-code").fill(uri);
    await page.getByTestId("m-pair-btn").click();
    await expect(page.getByTestId("m-status")).toHaveText("open");
    await page.getByTestId("m-setup").click();
    const sheet = page.getByTestId("m-setup-sheet");
    await expect(sheet.locator('[data-testid^="setup-p-"]')).toHaveCount(21);
    await shot(page, "mobile-providers");
    await sheet.getByTestId("setup-p-anthropic").click();
    await expect(sheet.getByTestId("setup-f-messages")).toHaveAttribute("aria-checked", "true");
    await sheet.getByTestId("setup-f-messages").click();
    await sheet.getByTestId("setup-key").fill("sk-test-key");
    await expect(sheet.getByTestId("setup-key")).toHaveAttribute("type", "password");
    await sheet.getByTestId("setup-fetch").click();
    await sheet.getByTestId("setup-model").first().click();
    await expect(sheet.getByTestId("setup-done")).toContainText("model-a");
    await sheet.getByTestId("setup-back").click();
    await sheet.getByTestId("setup-p-nous").click();
    await expect(sheet.getByTestId("setup-code")).toHaveText("WDJB-MJHT");
    await expect.poll(() => page.evaluate(() => (window as any).opened[0])).toContain("user_code=WDJB-MJHT");
    await shot(page, "mobile-device-code");
    await expect(sheet.getByTestId("setup-model").first()).toBeVisible({ timeout: 8000 });
    await sheet.getByTestId("setup-model").first().click();
    await expect(sheet.getByTestId("setup-done")).toContainText("model-a");
  });
});

test("desktop: the model picker stays in the composer after a provider setup save", async ({ page }) => {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1")) localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, onboarded: true, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-providers").click();
  await page.getByTestId("setup-filter").fill("groq");
  await page.getByTestId("setup-filter").press("Enter");
  await page.getByTestId("setup-f-chat_completions").click();
  await page.getByTestId("setup-key").fill("gsk-good");
  await page.getByTestId("setup-fetch").click();
  await page.getByTestId("setup-model").nth(1).click();
  await expect(page.getByTestId("setup-done")).toContainText("model-b");
  // The agent now advertises no `model` option (like the CLI after /setup): the picker falls back to the provider's list.
  await page.getByTestId("new-chat").first().click();
  await page.locator(".composer textarea").fill("hi");
  await page.locator(".composer textarea").press("Enter");
  const trigger = page.getByTestId("model-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText("Model B");
  await trigger.click();
  await expect(page.getByTestId("model-choice")).toHaveCount(3);
  if (process.env.MODEL_SHOT) await page.screenshot({ path: process.env.MODEL_SHOT });
  await page.getByTestId("model-choice").filter({ hasText: "Model A" }).click();
  await expect(trigger).toContainText("Model A");
});
