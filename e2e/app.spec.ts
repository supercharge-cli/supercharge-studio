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
  await card.locator("summary").click();
  await expect(card).toContainText("README.md");
  await page.getByRole("button", { name: /Tools \(1\)/ }).click();
  await expect(page.locator(".toollist .toolcard")).toContainText("Run ls -la");
});

test("permission dialog answers the agent", async ({ page }) => {
  await boot(page);
  await ask(page, "perm check");
  await expect(page.locator(".modal")).toContainText("Delete build folder");
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
  await expect(page.locator(".slash")).toContainText("/setup");
  await page.locator(".slash button", { hasText: "/setup" }).click();
  await expect(page.locator(".composer textarea")).toHaveValue("/setup ");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-agent").click();
  await expect(page.locator(".modal")).toContainText("supercharge/demo");
  await page.getByTestId("tab-appearance").click();
  await page.getByTestId("theme-light").click();
  await page.getByTestId("tab-providers").click();
  await page.getByTestId("prov-add").click();
  await page.getByTestId("prov-name").fill("Local");
  await page.getByTestId("prov-models").fill("m-1, m-2");
  await page.getByTestId("settings-save").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-providers").click();
  await expect(page.getByTestId("provider-row")).toContainText("m-1, m-2");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("missing provider key shows /setup hint", async ({ page }) => {
  await boot(page);
  await ask(page, "authfail");
  await expect(page.locator(".bubble.system").last()).toContainText("/setup");
  await expect(page.locator(".bubble.system").last()).toContainText("401");
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
  await expect(page.locator(".bubble.system").last()).toContainText("not available from your provider");
});
