import { expect, Page, test } from "@playwright/test";

// The composer's bottom row must keep send fully inside the box at phone widths, with chips truncating instead of clipping.
const SHOT = process.env.COMPOSER_SHOTS;
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

async function mobile(page: Page) {
  await page.route(/\/src\/mobile\/creds\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
    export const loadCreds = () => ({ deviceId: "d1", key: new Uint8Array(32), url: "ws://localhost", name: "Phone" });
    export const saveCreds = () => {}; export const defaultDeviceName = () => "Phone"; export const pendingCredsFromCode = async () => ({});
  ` }));
  await page.route(/\/src\/acp\/client\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
    const opts = [{ id: "model", currentValue: "m", options: [{ value: "m", name: "test-model-with-a-really-long-name-1m" }, { value: "x", name: "Other" }] }, { id: "permission_mode", currentValue: "always-approve", options: [{ value: "ask", name: "Ask" }, { value: "always-approve", name: "Always Approve" }] }];
    export class AcpClient {
      constructor(o) { this.opts = o; }
      async connect() { this.opts.onStateChange("open"); }
      async initialize() { return {}; }
      async listSessions() { return { sessions: [{ sessionId: "s1", title: "First", cwd: "/workspace" }], _meta: { projects: [] } }; }
      async loadSession() { return { configOptions: opts, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } }; }
      async setConfigOption() { return { configOptions: opts }; }
      close() {}
    }
  ` }));
  await page.goto("/mobile.html");
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-send")).toBeVisible();
}

async function inside(page: Page, box: string, el: string) {
  const b = (await page.locator(box).boundingBox())!;
  const s = (await page.locator(el).boundingBox())!;
  expect(s.x).toBeGreaterThanOrEqual(b.x - 0.5);
  expect(s.x + s.width).toBeLessThanOrEqual(b.x + b.width + 0.5);
}

for (const [w, h] of [[320, 700], [360, 800], [412, 915]]) {
  test(`mobile composer row fits at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await mobile(page);
    await inside(page, ".m-compose-row", '[data-testid="m-send"]');
    for (const id of ["m-mode-chip", "m-model-chip"]) await inside(page, ".m-compose-row", `[data-testid="${id}"]`);
    // Row must not scroll sideways or push past the viewport.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    if (SHOT) await page.locator(".m-composer").screenshot({ path: `${SHOT}-mobile-${w}.png` });
  });
}

const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false };
for (const [w, h] of [[700, 800], [1280, 800]]) {
  test(`desktop composer fits at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.addInitScript((s) => {
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
    }, SETTINGS);
    await page.goto("/");
    await expect(page.locator(".status")).toHaveText("open");
    const send = page.locator('.composer button[aria-label="Send"], .composer [data-testid="send"]').first();
    await expect(send).toBeVisible();
    await inside(page, ".composer", '.composer button[aria-label="Send"], .composer [data-testid="send"]');
    if (SHOT) await page.screenshot({ path: `${SHOT}-desktop-${w}.png` });
  });
}
