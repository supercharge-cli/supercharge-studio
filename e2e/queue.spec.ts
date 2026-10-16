import { expect, Page, test } from "@playwright/test";

async function boot(page: Page, bind: string, extra: Record<string, unknown> = {}) {
  await page.addInitScript(([b, x]) => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: { bind: b, secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true, ...(x as object) }, groups: [{ id: "g1", name: "P", projects: [{ id: "p1", name: "q", cwd: "/srv/q", chats: [] }] }], activeProjectId: "p1", sidebarView: "projects", schema: 2 }));
  }, [bind, extra] as const);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}
const type = async (page: Page, t: string) => { await page.locator(".composer textarea").fill(t); await page.locator(".composer textarea").press("Enter"); };

test("messages sent while the agent works are queued, editable, removable, and sent after the turn", async ({ page }) => {
  await boot(page, "127.0.0.1:2421");
  await type(page, "slow");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await type(page, "first queued");
  await type(page, "second queued");
  await expect(page.getByTestId("queued")).toHaveCount(2);
  await page.getByTestId("queued-text").first().click();
  await page.getByTestId("queued-edit").fill("stream updated");
  await page.getByTestId("queued-edit").press("Enter");
  await page.getByTestId("queued").nth(1).getByTestId("queued-remove").click();
  await expect(page.getByTestId("queued")).toHaveCount(1);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByTestId("queued")).toHaveCount(0);
  await expect(page.locator(".bubble.user").last()).toHaveText("stream updated");
  await expect(page.locator(".bubble.agent").last()).toContainText("Hello from the fake agent.");
  await expect(page.getByText("second queued")).toHaveCount(0);
});

test("steer without native support: cancel and resend with the text appended", async ({ page }) => {
  await boot(page, "127.0.0.1:2421");
  await type(page, "slow");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await type(page, "no-slow stream");
  await page.getByTestId("queued-steer").click();
  await expect(page.getByText("stopped: cancelled")).toBeVisible();
  // The resent prompt ("slow" + the steering text) runs the "stream" scenario.
  await expect(page.locator(".bubble.agent").last()).toContainText("Hello from the fake agent.", { timeout: 10000 });
  await expect(page.locator(".bubble.user").last()).toHaveText("no-slow stream");
});

test("native steer injects into the running turn without cancelling (steer by default)", async ({ page }) => {
  await boot(page, "127.0.0.1:2452", { steerByDefault: true });
  await page.locator('[data-testid="new-chat"]').first().click();
  await type(page, "slow finish");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await type(page, "also check the tests");
  await expect(page.getByTestId("queued")).toHaveCount(0);
  await expect(page.locator(".bubble.agent").last()).toContainText("steered: also check the tests", { timeout: 10000 });
  await expect(page.getByText("stopped: cancelled")).toHaveCount(0);
});
