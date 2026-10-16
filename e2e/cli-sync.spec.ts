import { expect, test } from "@playwright/test";

// Keep runs hermetic: the live release check would open a blocking update banner whenever a newer release is published.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

// Agent on 2452 behaves like the Supercharge CLI's session store (FAKE_AGENT_CLI=1).
const SETTINGS = { bind: "127.0.0.1:2452", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true };

test("sidebar shows every CLI session grouped by folder, loads any of them, and follows live changes", async ({ page }) => {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      // Old (v1) data: an app-only group with a project that shares a folder with the CLI.
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "alpha-app", cwd: "/srv/alpha/", chats: [{ id: "c0", title: "My app chat", createdAt: Date.now() - 3600_000 * 3 }] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  const tree = page.getByTestId("folder-tree");
  // Pagination (2 per page) brought in all four sessions from three folders.
  await expect(tree.locator('[data-testid="chat"][data-session^="cli-"]')).toHaveCount(4);
  const alpha = tree.locator('[data-testid="project"][data-cwd="/srv/alpha"]');
  await expect(alpha.getByTestId("project-name")).toContainText("alpha-app");
  await expect(alpha.getByTestId("chat-title")).toHaveText(["Fix login bug", "My app chat", "Refactor auth"]);
  await expect(alpha.getByTestId("chat-time")).toHaveText(["5m", "3h", "1d"]);
  await expect(tree.locator('[data-cwd="/srv/beta"]').getByTestId("project-name")).toContainText("beta");
  await expect(tree.locator('[data-cwd="/home/u/gamma"]').getByTestId("chat-title")).toHaveText("Untitled chat");

  // Open a CLI session: full history replays.
  await alpha.getByText("Fix login bug").click();
  await expect(page.locator(".bubble.agent").last()).toHaveText("History of cli-a1 in /srv/alpha");

  // Old session saved with a retired model: switch to a configured one and say so.
  await tree.locator('[data-cwd="/home/u/gamma"]').getByText("Untitled chat").click();
  await expect(page.locator(".bubble.agent").last()).toHaveText("History of cli-old in /home/u/gamma");
  await expect(page.getByText(/last used with "retired-model".*Switched it to "model-a"/)).toBeVisible();

  // Live update from the CLI (_supercharge/sessions/changed).
  await page.locator(".composer textarea").fill("addcli please");
  await page.locator(".composer textarea").press("Enter");
  await expect(tree.locator('[data-cwd="/srv/delta"]').getByTestId("chat-title")).toHaveText("Started in the terminal");

  // New chat in a new folder goes through session/new with that cwd, so the CLI lists it too.
  await page.getByTestId("open-folder").click();
  await page.getByTestId("inline-input").fill("/srv/epsilon");
  await page.getByTestId("inline-input").press("Enter");
  await page.locator(".composer textarea").fill("hello");
  await page.locator(".composer textarea").press("Enter");
  const eps = tree.locator('[data-cwd="/srv/epsilon"]');
  await expect(eps.getByTestId("chat")).toHaveCount(1);
  await expect(eps.locator('[data-session^="fake-"]')).toHaveCount(1);

  // Removing a chat hides it; sync doesn't bring it back. Recents lists chats from every project.
  await page.reload();
  await expect(page.locator(".status")).toHaveText("open");
  await page.getByTestId("view-recents").click();
  await expect(page.getByTestId("recents").getByTestId("chat").first()).toBeVisible();
  await page.getByTestId("view-projects").click();
  const beta = tree.locator('[data-cwd="/srv/beta"]');
  await beta.getByTestId("chat").getByTestId("delete").click();
  await beta.getByTestId("confirm-delete").click();
  await page.getByTestId("sync-sessions").click();
  await page.waitForTimeout(500);
  await expect(tree.locator('[data-session="cli-b1"]')).toHaveCount(0);
});
