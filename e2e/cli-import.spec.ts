import { expect, test } from "@playwright/test";
import { shotPath } from "./shot";

// Keep runs hermetic: the live release check would open a blocking update banner whenever a newer release is published.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

// The fake on 2453 is a CLI already set up with OpenRouter (key saved in the CLI, never sent to Studio).
const SETTINGS = { bind: "127.0.0.1:2453", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true };
const stored = (page: import("@playwright/test").Page) => page.evaluate(() => JSON.parse(localStorage.getItem("supercharge-studio/v1") ?? "{}").settings);

test("desktop: imports the CLI's provider on connect, keeps removals, re-imports on request", async ({ page }) => {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1")) localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1", onboarded: true }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await expect.poll(async () => (await stored(page)).providers?.length ?? 0).toBe(1);
  const s = await stored(page);
  expect(s.providers[0]).toMatchObject({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: ["model-a", "model-b"], cli: "openrouter|https://openrouter.ai/api/v1" });
  expect(JSON.stringify(s)).not.toMatch(/apiKey|sk-|hasApiKey/);

  // Model picker lists the CLI's models without any setup.
  await page.getByTestId("new-chat").first().click();
  await page.locator(".composer textarea").fill("hi");
  await page.locator(".composer textarea").press("Enter");
  await page.getByTestId("model-trigger").click();
  await expect(page.getByTestId("model-picker")).toContainText("Model A");
  await expect(page.getByTestId("model-picker")).toContainText("Model B");
  await page.screenshot({ path: shotPath("cli-import-picker.png") });
  await page.keyboard.press("Escape");

  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-providers").click();
  const row = page.getByTestId("provider-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("prov-cli")).toHaveText(" · Imported from CLI");
  await expect(page.getByTestId("cli-import")).toBeChecked();
  await row.getByTestId("prov-edit").click();
  await expect(page.getByTestId("provider-editor")).toContainText("The key stays in the Supercharge CLI.");
  await expect(page.getByTestId("prov-key")).toHaveCount(0);
  await page.screenshot({ path: shotPath("cli-import-settings.png") });

  // Removing it sticks across reconnects; only "Re-import from CLI" brings it back.
  await page.getByTestId("provider-editor").getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
  await page.getByTestId("settings-save").click();
  await expect.poll(async () => (await stored(page)).cliRemoved).toEqual(["openrouter|https://openrouter.ai/api/v1"]);
  await page.reload();
  await expect(page.locator(".status")).toHaveText("open");
  await page.waitForTimeout(800);
  expect((await stored(page)).providers ?? []).toHaveLength(0);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-providers").click();
  await page.getByTestId("cli-reimport").click();
  await expect(page.getByTestId("provider-row")).toHaveCount(1);
  await expect.poll(async () => (await stored(page)).cliRemoved ?? []).toEqual([]);
  await expect.poll(async () => (await stored(page)).providers?.length).toBe(1);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("shows the computer's CLI provider with its label, toggle and re-import", async ({ page }) => {
    await page.route(/\/src\/mobile\/creds\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
      export const loadCreds = () => ({ deviceId: "d1", key: new Uint8Array(32), url: "ws://localhost", name: "Phone" });
      export const saveCreds = () => {};
      export const defaultDeviceName = () => "Phone";
      export const pendingCredsFromCode = async () => ({});
    ` }));
    await page.route(/\/src\/acp\/client\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
      const status = { configured: true, providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", format: "openai", modelId: "model-a", hasApiKey: true };
      window.saves = [];
      export class AcpClient {
        constructor(opts) { this.opts = opts; }
        async connect() { this.opts.onStateChange("open"); }
        async initialize() { this.initResult = { agentCapabilities: { _meta: { supercharge: { setup: true } } } }; return this.initResult; }
        async listSessions() { return { sessions: [], _meta: { projects: [] } }; }
        async ext(method, p) {
          if (p.op === "status") return status;
          if (p.op === "models") return { models: [{ id: "model-a", name: "Model A" }, { id: "model-b", name: "Model B" }] };
          if (p.op === "save") { window.saves.push(p); return { ok: true, status }; }
          return {};
        }
        close() {}
      }
    ` }));
    await page.goto("/mobile.html");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("supercharge-mobile/cli-providers") ?? "[]").length)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("supercharge-mobile/cli-providers"))).not.toMatch(/apiKey|sk-/);
    await page.getByTestId("m-setup").click();
    const box = page.getByTestId("m-cli-providers");
    await expect(box.getByTestId("m-cli-provider")).toContainText("OpenRouter");
    await expect(box.getByTestId("m-cli-provider")).toContainText("Imported from CLI");
    await expect(box.getByTestId("m-cli-import")).toBeChecked();
    await page.waitForTimeout(450);
    await page.screenshot({ path: shotPath("cli-import-mobile.png") });
    await box.getByRole("button", { name: "Use" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).saves.length)).toBe(1);
    const save = await page.evaluate(() => (window as any).saves[0]);
    expect(save).toMatchObject({ op: "save", providerId: "openrouter", modelId: "model-a" });
    expect(save).not.toHaveProperty("apiKey");
    await box.getByRole("button", { name: "Remove" }).click();
    await expect(box.getByTestId("m-cli-provider")).toHaveCount(0);
    await box.getByTestId("m-cli-reimport").click();
    await expect(box.getByTestId("m-cli-provider")).toHaveCount(1);
  });
});
