import { expect, test, type Page } from "@playwright/test";
import { shotPath } from "./shot";

// Settings → Providers driven by the CLI's provider catalogue (fake CLI on 2458), and the
// older-CLI fallback (fake CLI on 2452 has no catalogue and answers method-not-found).
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
  await page.addInitScript(() => { (window as any).opened = []; window.open = ((u: string) => { (window as any).opened.push(u); return null; }) as any; });
});
test.describe.configure({ mode: "serial" });

const OUT = process.env.PROVIDER_SHOTS;
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(300);
  await page.getByTestId("provider-manager").screenshot({ path: OUT ? `${OUT}/${name}.png` : shotPath(`providers-${name}.png`) });
};

async function openProviders(page: Page, port = 2458) {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1")) localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [], onboarded: true }));
  }, { bind: `127.0.0.1:${port}`, secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true });
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-providers").click();
}

test("picker lists every provider the CLI sends, plus a custom provider", async ({ page }) => {
  await openProviders(page);
  await expect(page.getByTestId("pm-current")).toContainText("No provider is active");
  await expect(page.getByTestId("pm-empty")).toBeVisible();
  // The Studio-side "Add provider" button is gone: one way to add a provider.
  await expect(page.getByTestId("prov-add")).toHaveCount(0);
  await page.getByTestId("pm-add").click();
  for (const id of ["openai", "nous", "mistral-auth", "agentrouter", "ollama", "lmstudio", "custom"]) await expect(page.getByTestId(`pm-p-${id}`)).toBeVisible();
  await expect(page.getByTestId("pm-p-nous")).toContainText("Sign in with a code");
  await expect(page.getByTestId("pm-p-mistral-auth")).toContainText("Browser sign-in");
  await expect(page.getByTestId("pm-p-ollama")).toContainText("Local server");
  await shot(page, "add-provider-picker");
  await page.getByTestId("pm-filter").fill("router");
  await expect(page.locator('[data-testid^="pm-p-"]')).toHaveCount(2); // OpenRouter, AgentRouter
  await page.getByTestId("pm-filter").fill("local");
  await expect(page.getByTestId("pm-p-ollama")).toBeVisible();
  await page.getByTestId("pm-filter").press("Enter");
  await expect(page.getByTestId("pm-detail")).toBeVisible();
  await expect(page.getByTestId("pm-key")).toHaveAttribute("placeholder", "Optional");
});

test("API key: a rejected key saves nothing, a good one lists models and becomes active", async ({ page }) => {
  await openProviders(page);
  await page.getByTestId("pm-add").click();
  await page.getByTestId("pm-filter").fill("agentrouter");
  await page.getByTestId("pm-p-agentrouter").click();
  await expect(page.getByTestId("pm-meta")).toContainText("Responses");
  const key = page.getByTestId("pm-key");
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("bad");
  await page.getByTestId("pm-save-key").click();
  await expect(page.getByTestId("pm-error")).toContainText("rejected the key");
  await page.getByTestId("pm-retry").click();
  await expect(page.getByTestId("pm-key")).toHaveValue("");
  await page.getByTestId("pm-key").fill("sk-e2e-secret-123");
  await shot(page, "api-key-form");
  await page.getByTestId("pm-save-key").click();
  await expect(page.getByTestId("pm-model")).toHaveCount(4);
  await page.getByTestId("pm-model").first().click();
  await expect(page.getByTestId("pm-done")).toContainText("AgentRouter · model-a");
  await page.getByTestId("pm-done-ok").click();
  await expect(page.getByTestId("pm-current")).toContainText("AgentRouter");
  await expect(page.getByTestId("pm-row-agentrouter").getByTestId("pm-state")).toContainText("Active");
  await shot(page, "providers-home");
  // The active provider cannot be removed; the key never shows again.
  await expect(page.getByTestId("pm-row-agentrouter").getByTestId("pm-remove")).toHaveCount(0);
  expect(await page.content()).not.toContain("sk-e2e-secret-123");
  await page.getByTestId("pm-row-agentrouter").getByTestId("pm-edit").click();
  await expect(page.getByTestId("pm-key")).toHaveValue("");
  await expect(page.getByTestId("pm-key")).toHaveAttribute("placeholder", /Key saved/);
});

test("custom provider: the CLI checks the URL, then it can be used and removed", async ({ page }) => {
  await openProviders(page);
  await page.getByTestId("pm-add").click();
  await page.getByTestId("pm-p-custom").click();
  await page.getByTestId("pm-c-name").fill("My Gateway");
  await page.getByTestId("pm-c-url").fill("http://10.1.2.3/v1");
  await page.getByTestId("pm-c-format").selectOption("anthropic");
  await page.getByTestId("pm-c-key").fill("sk-gw");
  await page.getByTestId("pm-c-save").click();
  await expect(page.getByTestId("pm-error")).toContainText("loopback");
  await page.getByTestId("pm-retry").click();
  await expect(page.getByTestId("pm-c-key")).toHaveValue("");
  await page.getByTestId("pm-c-url").fill("https://gw.example.test/v1");
  await page.getByTestId("pm-c-key").fill("sk-gw");
  await shot(page, "custom-provider-form");
  await page.getByTestId("pm-c-save").click();
  await expect(page.getByTestId("pm-model")).toHaveCount(4);
  await page.getByTestId("pm-model-filter").fill("type");
  await page.getByTestId("pm-model").click();
  await page.getByTestId("pm-typed").fill("gw/custom-model");
  await page.getByTestId("pm-typed-save").click();
  await expect(page.getByTestId("pm-done")).toContainText("My Gateway · gw/custom-model");
  await page.getByTestId("pm-done-ok").click();
  // Switch back so the custom provider is no longer active, then remove it.
  await page.getByTestId("pm-row-agentrouter").getByTestId("pm-use").click();
  await page.getByTestId("pm-model").first().click();
  await page.getByTestId("pm-done-ok").click();
  await page.getByTestId("pm-row-custom-my-gateway").getByTestId("pm-remove").click();
  await page.getByTestId("pm-remove-yes").click();
  await expect(page.getByTestId("pm-row-custom-my-gateway")).toHaveCount(0);
});

test("device code: shows the code and link, waits for approval, then picks a model", async ({ page }) => {
  await openProviders(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("pm-add").click();
  await page.getByTestId("pm-filter").fill("nous");
  await page.getByTestId("pm-p-nous").click();
  await expect(page.getByTestId("pm-key")).toHaveCount(0); // no key field without "api_key"
  await page.getByTestId("pm-signin-device").click();
  await expect(page.getByTestId("pm-auth-code")).toHaveText("WDJB-MJHT");
  await expect(page.getByTestId("pm-auth-url")).toHaveText(/oauth\/device/);
  await expect.poll(() => page.evaluate(() => (window as any).opened.length)).toBe(1);
  await page.getByTestId("pm-copy-code").click();
  await expect(page.getByTestId("pm-copy-code")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("WDJB-MJHT");
  await shot(page, "device-code");
  await expect(page.getByTestId("pm-model").first()).toBeVisible({ timeout: 10000 });
  await page.getByTestId("pm-model").nth(1).click();
  await expect(page.getByTestId("pm-done")).toContainText("model-b");
});

test("browser sign-in: opens the link (no code), then the CLI makes it active", async ({ page }) => {
  await openProviders(page);
  await page.getByTestId("pm-add").click();
  await page.getByTestId("pm-filter").fill("mistral");
  await page.getByTestId("pm-p-mistral-auth").click();
  await page.getByTestId("pm-signin-browser").click();
  await expect(page.getByTestId("pm-auth-url")).toHaveText(/^https:\/\//);
  await expect(page.getByTestId("pm-auth-code")).toHaveCount(0);
  await expect(page.getByTestId("pm-open")).toBeVisible();
  await shot(page, "browser-sign-in");
  await expect(page.getByTestId("pm-model").first()).toBeVisible({ timeout: 10000 });
  await page.getByTestId("pm-model").first().click();
  await page.getByTestId("pm-done-ok").click();
  await expect(page.getByTestId("pm-row-mistral-auth").getByTestId("pm-state")).toContainText("Active");
  // Signing out of the device-code provider (not active) through Remove.
  await expect(page.getByTestId("pm-row-nous").getByTestId("pm-state")).toContainText("Signed in");
  await page.getByTestId("pm-row-nous").getByTestId("pm-remove").click();
  await page.getByTestId("pm-remove-yes").click();
  await expect(page.getByTestId("pm-row-nous")).toHaveCount(0);
});

test("older CLI: falls back to the basic setup with a note to update", async ({ page }) => {
  await openProviders(page, 2452);
  await expect(page.getByTestId("prov-update-cli")).toContainText("Update the Supercharge CLI");
  await expect(page.getByTestId("provider-setup")).toBeVisible();
  await expect(page.getByTestId("setup-p-groq")).toBeVisible();
  await expect(page.getByTestId("provider-manager")).toHaveCount(0);
  await expect(page.getByTestId("prov-add")).toBeVisible();
});
