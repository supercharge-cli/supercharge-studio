import { expect, test } from "@playwright/test";

const GW = "http://127.0.0.1:2431";
test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

test("phone: message search on Recents opens the chat at the match; photo picker present", async ({ page }) => {
  const { uri } = await (await fetch(`${GW}/pair`)).json();
  await page.goto("/mobile.html");
  await page.getByTestId("m-name").fill("Pixel Search");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-status")).toHaveText("open");
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-thread")).toContainText("The token check is inverted.");
  await expect(page.getByTestId("m-photo")).toBeVisible();
  await expect(page.getByTestId("m-photo-input")).toHaveAttribute("accept", "image/*");
  await page.waitForTimeout(900); // index debounce
  await page.getByTestId("m-back").click();
  await page.getByTestId("m-search").fill("check is inverted");
  const hit = page.getByTestId("m-search-hit").first();
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark")).toHaveText(/check is inverted/i);
  await page.screenshot({ path: "/workspace/out/n-mobile-search.png" });
  await hit.click();
  await expect(page.locator(".m-thread .search-flash")).toHaveCount(1);
});
