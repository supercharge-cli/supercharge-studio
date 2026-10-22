import { expect, Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false };

async function boot(page: Page) {
  await page.addInitScript((s) => {
    localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp/demo", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}

test("file tree shows every file: whole big folders, ignored toggle and lazily loaded capped folders", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const big = Array.from({ length: 250 }, (_, i) => ({ path: `big/f${String(i).padStart(3, "0")}.ts`, dir: false }));
    const list = [
      { path: ".env.example", dir: false }, { path: "README.md", dir: false },
      { path: "big/", dir: true }, ...big,
      { path: "deep/", dir: true, partial: true },
      { path: "node_modules/", dir: true, partial: true, ignored: true },
      { path: "debug.log", dir: false, ignored: true },
    ];
    (window as any).__dirCalls = [];
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd: string, args: any) => {
      if (cmd === "fs_list") return list;
      if (cmd === "fs_list_dir") {
        (window as any).__dirCalls.push(args.rel);
        if (args.rel === "deep/") return [{ path: "deep/more/", dir: true, partial: true }, { path: "deep/leaf.rs", dir: false }];
        if (args.rel === "node_modules/") return [{ path: "node_modules/react/", dir: true, partial: true }];
        return [];
      }
      return null;
    } };
  });
  await page.getByTitle("Show side panel (Ctrl \\)").click();
  await page.getByTestId("files-tab").click();
  const pane = page.getByTestId("files-pane");
  await expect(pane.locator('[data-path=".env.example"]')).toBeVisible();
  await expect(pane.locator('[data-path="node_modules/"]')).toHaveCount(0);
  await expect(page.getByTestId("files-meta")).toContainText("Show ignored (2)");
  await expect(page.getByTestId("files-meta")).toContainText("1 folder loads on open");
  await pane.locator('[data-path="big/"]').click();
  await expect(pane.locator('[data-path^="big/f"]')).toHaveCount(250);
  await pane.locator('[data-path="big/"]').click();
  await pane.locator('[data-path="deep/"]').click();
  await expect(pane.locator('[data-path="deep/leaf.rs"]')).toBeVisible();
  await page.getByTestId("files-show-ignored").check();
  await expect(pane.locator('[data-path="debug.log"]')).toBeVisible();
  await pane.locator('[data-path="node_modules/"]').click();
  await expect(pane.locator('[data-path="node_modules/react/"]')).toHaveClass(/ignored/);
  expect(await page.evaluate(() => (window as any).__dirCalls)).toEqual(["deep/", "node_modules/"]);
  if (process.env.SHOTS) await pane.screenshot({ path: `${process.env.SHOTS}/file-tree.png` });
});
