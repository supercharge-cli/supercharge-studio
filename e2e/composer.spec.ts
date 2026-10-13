import { expect, Page, test } from "@playwright/test";

const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false };
async function boot(page: Page) {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}

test("slash menu lists app and agent commands, filters, and runs with the keyboard", async ({ page }) => {
  await boot(page);
  const box = page.locator(".composer textarea");
  await box.fill("/");
  const menu = page.getByTestId("composer-menu");
  await expect(menu).toBeVisible();
  for (const c of ["/new", "/clear", "/setup", "/models", "/theme", "/help"]) await expect(menu).toContainText(c);
  await expect(menu.locator(".cmenu-group")).toHaveText(["App", "Agent"]);
  await box.pressSequentially("thm");
  await expect(menu.getByTestId("composer-menu-item").first()).toContainText("/theme");
  await box.press("Enter");
  await expect(box).toHaveValue("/theme ");
  await expect(menu).toContainText("Light");
  await box.pressSequentially("lig");
  await box.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(box).toHaveValue("");
  // Escape closes the menu; typed "/setup" + Enter opens provider settings.
  await box.fill("/se");
  await expect(menu).toBeVisible();
  await box.press("Escape");
  await expect(menu).toBeHidden();
  await box.fill("/setup");
  await box.press("ArrowDown");
  await box.press("ArrowUp");
  await box.press("Enter");
  await expect(page.getByTestId("tab-providers")).toHaveClass(/\bon\b/);
});

test("/help lists commands and agent commands still go to the agent", async ({ page }) => {
  await boot(page);
  const box = page.locator(".composer textarea");
  await box.fill("/help");
  await box.press("Escape");
  await box.press("Enter");
  await expect(page.locator(".messages")).toContainText("/models");
  await expect(page.locator(".messages")).toContainText("Configure provider");
});
