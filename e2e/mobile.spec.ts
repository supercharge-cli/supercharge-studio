import { expect, test } from "@playwright/test";

const GW = "http://127.0.0.1:2431";
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

async function pair(page: import("@playwright/test").Page) {
  const { uri } = await (await fetch(`${GW}/pair`)).json();
  await page.goto("/mobile.html");
  await page.getByTestId("m-name").fill("Pixel Test");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-list")).toBeVisible();
  await expect(page.getByTestId("m-status")).toHaveText("open");
}

const shot = (page: import("@playwright/test").Page, name: string) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : Promise.resolve());

test("pairs with the gateway, lists projects/chats and replays history", async ({ page }) => {
  const keyWarnings: string[] = [];
  page.on("console", (m) => /same key/.test(m.text()) && keyWarnings.push(m.text()));
  await pair(page);
  await expect(page.getByTestId("m-list")).toContainText("api");
  await shot(page, "40-mobile-list");
  await expect(page.getByTestId("m-chat").first()).toContainText("Fix login bug");
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-thread")).toContainText("The token check is inverted.");
  await expect(page.locator(".m-thread strong")).toHaveText("token");
  expect(keyWarnings).toEqual([]);
  // reload: credentials persist, device reconnects with its own key (no pairing)
  await page.reload();
  await expect(page.getByTestId("m-status")).toHaveText("open");
});

test("continues a session with streaming and diff tool cards", async ({ page }) => {
  await pair(page);
  await page.getByTestId("m-chat").first().click();
  await page.getByTestId("m-input").fill("please fix it");
  await page.getByTestId("m-send").click();
  await expect(page.locator(".bubble.agent").last()).toHaveText("Sure — working on it.");
  await expect(page.locator(".bubble.user").last()).toHaveText("please fix it");
  await expect(page.locator(".toolcard .tc-diffstat").last()).toHaveText("+1 −1");
  if (process.env.SHOTS) await page.waitForTimeout(400);
  await shot(page, "41-mobile-chat");
});

test("answers permission requests and receives handoffs", async ({ page }) => {
  await pair(page);
  await page.getByTestId("m-chat").first().click();
  await page.getByTestId("m-input").fill("perm please");
  await page.getByTestId("m-send").click();
  await expect(page.getByTestId("m-perm")).toContainText("Run npm test");
  if (process.env.SHOTS) await page.waitForTimeout(500);
  await shot(page, "42-mobile-permission");
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByTestId("m-thread")).toContainText("Permission: selected:y");
  await page.getByTestId("m-back").click();
  await fetch(`${GW}/handoff?sid=s2`);
  await page.getByTestId("m-handoff").click();
  await expect(page.locator(".m-title")).toHaveText("Write release notes");
});

test("rejects a reused pairing code", async ({ page }) => {
  const { uri } = await (await fetch(`${GW}/pair`)).json();
  await page.goto("/mobile.html");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-list")).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await page.goto("/mobile.html");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-error")).toContainText("expired pairing");
});

test("falls back to the relay when the direct route is unreachable, still end-to-end encrypted", async ({ page }) => {
  const { uri } = await (await fetch(`${GW}/pair?relay=1`)).json();
  await page.goto("/mobile.html");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-list")).toBeVisible();
  await expect(page.getByTestId("m-route")).toHaveText("relay");
  await page.getByTestId("m-chat").first().click();
  await page.getByTestId("m-input").fill("via relay");
  await page.getByTestId("m-send").click();
  await expect(page.locator(".bubble.agent").last()).toHaveText("Sure — working on it.");
  const stats = await (await fetch(`${GW}/relay-stats`)).json();
  expect(stats.connections).toBeGreaterThanOrEqual(2); // pairing + session
  expect(stats.binaryFrames).toBeGreaterThan(4);
  expect(stats.plaintextSeen).toBe(false);
});
