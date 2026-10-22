import { expect, test } from "@playwright/test";

// Phone side of the new features: saved prompts as / pills, notification answers and the widget feed.
const GW = "http://127.0.0.1:2431";
const OUT = process.env.FEATURE_SHOTS;
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

async function pair(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as any).__widget = [];
    (window as any).SuperchargeAndroid = { widget: (j: string) => (window as any).__widget.push(JSON.parse(j)), keepAlive() {}, notify() {}, notifyPermission() {} };
  });
  const { uri } = await (await fetch(`${GW}/pair`)).json();
  await page.goto("/mobile.html");
  await page.getByTestId("m-name").fill("Pixel Test");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-status")).toHaveText("open");
}

test("saved prompts show as / suggestions on the phone", async ({ page }) => {
  await pair(page);
  await page.getByTestId("m-chat").first().click();
  await page.getByTestId("m-input").fill("/");
  await expect(page.getByTestId("m-prompt")).toHaveText(["/review", "/fix-issue"]);
  await page.getByTestId("m-input").fill("/fi");
  await expect(page.getByTestId("m-prompt")).toHaveText(["/fix-issue"]);
  if (OUT) await page.screenshot({ path: `${OUT}/feat-mobile-prompts.png` });
  await page.getByTestId("m-prompt").click();
  await expect(page.getByTestId("m-input")).toHaveValue("/fix-issue ");
});

test("Allow from a notification answers the approval and the widget follows", async ({ page }) => {
  await pair(page);
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-thread")).toBeVisible();
  await fetch(`${GW}/perm`);
  await expect(page.getByTestId("m-perm")).toContainText("Delete dist");
  await expect.poll(() => page.evaluate(() => (window as any).__widget.at(-1)?.waiting)).toBe(1);
  if (OUT) await page.screenshot({ path: `${OUT}/feat-mobile-approval.png` });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("supercharge:answer", { detail: { key: "s1:t1", allow: true } })));
  await expect(page.getByTestId("m-perm")).toHaveCount(0);
  await expect.poll(async () => (await fetch(`${GW}/perm-result`)).json()).toEqual({ outcome: "selected", optionId: "ok" });
  await expect.poll(() => page.evaluate(() => (window as any).__widget.at(-1))).toMatchObject({ waiting: 0, linked: true });
});
