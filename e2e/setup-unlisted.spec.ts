import { expect, test, type Page } from "@playwright/test";

// Keep runs hermetic: the live release check would open a blocking update banner whenever a newer release is published.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

// Fake agent seeded with a CLI connected to "agentrouter", which the app's provider list does not know.
const SETTINGS = { bind: "127.0.0.1:2455", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true };

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

test("pulls a CLI-connected provider missing from the app's list into the wizard", async ({ page }) => {
  await openSetup(page);
  // The current line names the pulled provider, and its row sits just above Custom.
  await expect(page.getByTestId("setup-current")).toContainText("AgentRouter · gpt-5.6-sol");
  await expect(page.getByTestId("setup-p-agentrouter")).toContainText("AgentRouter");
  await expect(page.getByTestId("setup-p-agentrouter")).toContainText("Aggregator via AgentRouter");
  const rows = page.locator('[data-testid^="setup-p-"]');
  await expect(rows.last()).toHaveText("Custom / paste a base URL");

  // The pulled provider walks the same wizard, reusing the CLI's catalog details.
  await page.getByTestId("setup-p-agentrouter").click();
  await expect(page.getByTestId("setup-f-responses")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("setup-f-responses").click();
  await expect(page.getByTestId("setup-key")).toHaveAttribute("placeholder", "Saved key, leave blank to keep it");
  await page.getByTestId("setup-fetch").click();
  await page.getByTestId("setup-model").first().click();
  await expect(page.getByTestId("setup-done")).toContainText("model-a");

  // Still offered after saving: the CLI remains connected to it.
  await page.getByTestId("setup-back").click();
  await expect(page.getByTestId("setup-p-agentrouter")).toBeVisible();

  // The filter finds it by id and name.
  await page.getByTestId("setup-filter").fill("agentrouter");
  await expect(rows).toHaveCount(1);
});
