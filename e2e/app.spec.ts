import { expect, Page, test } from "@playwright/test";

const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false };

async function boot(page: Page) {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem(
        "supercharge-studio/v1",
        JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }),
      );
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}

async function ask(page: Page, text: string) {
  await page.locator(".composer textarea").fill(text);
  await page.locator(".composer textarea").press("Enter");
}

test("chat model control opens a searchable per-session picker", async ({ page }) => {
  await boot(page);
  await ask(page, "hello");
  await expect(page.getByTestId("model-trigger")).toBeVisible();
  await page.getByTestId("model-trigger").click();
  await expect(page.getByTestId("model-picker")).toBeVisible();
  await page.getByTestId("model-search").fill("second");
  await expect(page.getByTestId("model-choice")).toHaveCount(1);
  await page.getByTestId("model-choice").click();
  await expect(page.getByTestId("model-trigger")).toContainText("Second");
});

test("desktop model and thinking controls follow the selected chat", async ({ page }) => {
  await boot(page);
  await ask(page, "first chat");
  await expect(page.getByTestId("model-trigger")).toContainText("First");
  await expect(page.getByTestId("thinking-level")).toHaveValue("high");
  await page.getByTestId("model-trigger").click();
  await page.getByTestId("model-choice").filter({ hasText: "Second" }).click();
  await expect(page.getByTestId("model-trigger")).toContainText("Second");
  await page.getByTestId("thinking-level").selectOption("low");
  await expect(page.getByTestId("thinking-level")).toHaveValue("low");
  await page.getByTestId("new-chat").first().click();
  await ask(page, "other chat");
  await expect(page.getByTestId("model-trigger")).toContainText("First");
  await page.getByTestId("chat").filter({ hasText: "first chat" }).click();
  await expect(page.getByTestId("model-trigger")).toContainText("Second");
});

test("streams a reply with thought and plan", async ({ page }) => {
  await boot(page);
  await ask(page, "stream please");
  await expect(page.locator(".bubble.agent").last()).toHaveText("Hello from the fake agent.");
  await expect(page.locator(".bubble.thought")).toContainText("Thinking");
  await expect(page.locator(".plan")).toContainText("Say bye");
  await expect(page.getByTestId("chat-title").first()).toHaveText("stream please");
});

test("renders tool cards and the tools panel", async ({ page }) => {
  await boot(page);
  await ask(page, "tool run");
  const card = page.locator(".messages .toolcard");
  await expect(card).toHaveClass(/completed/);
  await expect(card).toContainText("Run ls -la");
  await card.locator(".tc-summary").click();
  await expect(card).toContainText("README.md");
  await page.getByRole("button", { name: /Tools \(1\)/ }).click();
  await expect(page.locator(".toollist .toolcard")).toContainText("Run ls -la");
});

test("permission dialog answers the agent", async ({ page }) => {
  await boot(page);
  await ask(page, "perm check");
  await expect(page.locator(".modal")).toContainText("Delete build folder");
  await expect(page.getByTestId("perm-modal")).toContainText("No, and tell the agent what to do differently");
  await expect(page.getByTestId("perm-modal")).not.toContainText("Zed");
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.locator(".bubble.agent").last()).toContainText("Permission outcome: selected:allow");
});

test("stop cancels a running turn", async ({ page }) => {
  await boot(page);
  await ask(page, "slow job");
  await expect(page.locator(".bubble.agent").last()).toContainText("tick2");
  await expect(page.locator(".topbar")).toBeInViewport();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".bubble.system").last()).toHaveText("stopped: cancelled");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("sidebar groups/projects/chats create, rename, delete and persist", async ({ page }) => {
  await boot(page);
  await page.getByTestId("view-groups").click();
  await page.getByTestId("add-group").click();
  await page.getByTestId("inline-input").fill("Work");
  await page.getByTestId("inline-input").press("Enter");
  const work = page.getByTestId("group").filter({ hasText: "Work" });
  await work.getByTestId("add-project").click();
  await page.getByTestId("inline-input").fill("api");
  await page.getByTestId("inline-input").press("Enter");
  await page.getByTestId("inline-input").fill("/srv/api");
  await page.getByTestId("inline-input").press("Enter");
  const api = work.getByTestId("project");
  await expect(api).toContainText("api");
  await api.getByTestId("rename-project").click();
  await page.getByTestId("inline-input").fill("api-server");
  await page.getByTestId("inline-input").press("Enter");
  await api.getByTestId("new-chat").click();
  await api.getByTestId("rename-chat").click();
  await page.getByTestId("inline-input").fill("Design notes");
  await page.getByTestId("inline-input").press("Enter");
  await work.getByTestId("rename-group").click();
  await page.getByTestId("inline-input").fill("Work stuff");
  await page.getByTestId("inline-input").press("Enter");
  await page.reload();
  const g = page.getByTestId("group").filter({ hasText: "Work stuff" });
  await expect(g.getByTestId("project-name")).toHaveText("api-server");
  await expect(g.getByTestId("chat-title")).toHaveText("Design notes");
  await g.getByTestId("chat").getByTestId("delete").click();
  await g.getByTestId("confirm-delete").click();
  await expect(g.getByTestId("chat")).toHaveCount(0);
  await g.getByTestId("project").getByTestId("delete").click();
  await g.getByTestId("confirm-delete").click();
  await expect(g.getByTestId("project")).toHaveCount(0);
  await g.locator(".group-head").getByTestId("delete").click();
  await g.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("group")).toHaveCount(1);
  await page.getByTestId("collapse-sidebar").click();
  await expect(page.getByTestId("expand-sidebar")).toBeVisible();
});

test("slash menu and settings", async ({ page }) => {
  await boot(page);
  await page.locator(".composer textarea").fill("/se");
  await expect(page.getByTestId("composer-menu")).toContainText("/setup");
  // The agent's own /setup (takes arguments) is inserted; the app's /setup opens settings.
  await page.getByTestId("composer-menu-item").filter({ hasText: "Configure provider" }).click();
  await expect(page.locator(".composer textarea")).toHaveValue("/setup ");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-agent").click();
  await expect(page.getByTestId("settings-screen")).toContainText("supercharge/demo");
  await page.getByTestId("tab-appearance").click();
  await page.getByTestId("theme-light").click();
  await page.getByTestId("tab-providers").click();
  await page.getByTestId("prov-add").click();
  await page.getByTestId("prov-name").fill("Local");
  await expect(page.getByTestId("prov-discover")).toBeDisabled();
  await expect(page.getByTestId("provider-editor")).toContainText("Model discovery requires the desktop app");
  await page.getByTestId("settings-save").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-providers").click();
  await expect(page.getByTestId("provider-row")).toContainText("no models");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("missing provider key shows /setup hint", async ({ page }) => {
  await boot(page);
  await ask(page, "authfail");
  await expect(page.locator(".bubble.error").last()).toContainText("/setup");
  await expect(page.locator(".bubble.error").last()).toContainText("401");
});

test("stale session id is replaced transparently", async ({ page }) => {
  await page.addInitScript((s) => {
    localStorage.setItem(
      "supercharge-studio/v1",
      JSON.stringify({
        settings: s,
        groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [{ id: "c1", title: "old", sessionId: "stale-1", createdAt: 1 }] }] }],
        activeProjectId: "p1",
        activeChatId: "c1",
      }),
    );
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await ask(page, "hello again");
  await expect(page.locator(".bubble.agent").last()).toHaveText("echo: hello again");
});

test("unsupported model shows a clear hint", async ({ page }) => {
  await boot(page);
  await ask(page, "modelfail");
  await expect(page.locator(".bubble.error").last()).toContainText("not available from your provider");
});

test("command palette: search and run commands with the keyboard", async ({ page }) => {
  await boot(page);
  await ask(page, "hello palette");
  await expect(page.locator(".bubble.agent").last()).toHaveText("echo: hello palette");
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("palette-input").fill("usage");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("usage-screen")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".composer textarea")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("new chat");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await expect(page.getByTestId("onboard-agent")).toHaveClass(/done/);
  await page.getByTestId("onboard-dismiss").click();
  await expect(page.locator(".empty h2")).toContainText("Start a chat");
  await page.keyboard.press("Control+,");
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByTestId("tab-devices").click();
  await expect(page.getByTestId("settings-screen")).toContainText("desktop app");
});

test("usage screen aggregates tokens and estimates cost from editable pricing", async ({ page }) => {
  await boot(page);
  await ask(page, "count me");
  await expect(page.locator(".bubble.agent").last()).toHaveText("echo: count me");
  await ask(page, "and again");
  await expect(page.locator(".bubble.agent").last()).toHaveText("echo: and again");
  await page.getByTestId("open-usage").click();
  await expect(page.getByTestId("stat-input")).toHaveText("2.4k"); // turn report counted once per turn
  await expect(page.getByTestId("stat-output")).toHaveText("600");
  await expect(page.locator(".tbl").first()).toContainText("fake-model");
  await page.getByTestId("price-input").fill("10");
  await page.getByTestId("price-output").fill("100");
  // (2400-400 cached billed at input when no cached price) ... all input at $10/M + 600 out at $100/M
  await expect(page.getByTestId("stat-cost")).toHaveText("$0.08");
  await page.getByTestId("period-month").click();
  await expect(page.getByTestId("stat-input")).toHaveText("2.4k");
  await expect(page.locator(".chart svg")).toBeVisible();
});

test("diff tool cards render added/removed lines and collapse", async ({ page }) => {
  await boot(page);
  await ask(page, "edit file");
  const card = page.locator(".messages .toolcard").first();
  await expect(card.getByTestId("diff")).toBeVisible();
  await expect(card.locator(".tc-diffstat")).toHaveText("+3 −2");
  await expect(card.locator(".dl.add").first()).toContainText("const b = 3;");
  await card.locator(".tc-summary").click();
  await expect(card).not.toHaveClass(/open/);
});

test("long chats are virtualized and stay pinned to the bottom", async ({ page }) => {
  await boot(page);
  await ask(page, "long run");
  await expect(page.locator(".messages")).toHaveAttribute("data-virtual", "true");
  await expect(page.locator(".bubble.agent").last()).toHaveText("line 299");
  expect(await page.locator(".row-wrap").count()).toBeLessThan(150);
  const atBottom = await page.locator(".messages").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  expect(atBottom).toBe(true);
});

test("failed turns show an error card with retry", async ({ page }) => {
  await boot(page);
  await ask(page, "flaky one");
  await expect(page.getByTestId("error-item")).toContainText("The turn failed");
  await page.getByTestId("retry").click();
  await expect(page.locator(".bubble.agent").last()).toContainText("flaky one");
});
