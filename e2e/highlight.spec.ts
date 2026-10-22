import { readFileSync } from "node:fs";
import { expect, Page, test } from "@playwright/test";

// Real output of the native highlighter (src-tauri/src/highlight.rs, `highlight_fixtures`), served by a mocked shell.
const fx = Object.fromEntries(["ts", "rust", "python", "go"].map((l) => [l, { code: readFileSync(`e2e/fixtures/hl-${l}.txt`, "utf8"), html: readFileSync(`e2e/fixtures/hl-${l}.html`, "utf8") }]));
const shot = (p: Page | import("@playwright/test").Locator, name: string) => (process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : Promise.resolve());

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

async function shell(page: Page) {
  await page.evaluate((fx) => {
    (window as any).__hl = [];
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd: string, args: any) => {
      if (cmd === "highlight_code") {
        (window as any).__hl.push(args.lang);
        const hit = Object.entries(fx).find(([, v]) => v.code === args.code || v.code === args.code + "\n");
        return hit ? hit[1].html : null;
      }
      if (cmd === "fs_list") return [{ path: "src/", dir: true }, { path: "src/cache.rs", dir: false }];
      if (cmd === "fs_read_text") return fx.rust.code;
      return null;
    } };
  }, fx);
}

test("desktop: code blocks and the file viewer are highlighted by the native grammars and follow the theme", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false }, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp/demo", chats: [] }] }], activeProjectId: "p1" }));
  });
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await shell(page);
  await page.locator(".composer textarea").fill("mdcode");
  await page.locator(".composer textarea").press("Enter");
  const blocks = page.locator(".md-code code.hl");
  await expect(blocks).toHaveCount(3);
  const kw = blocks.first().locator(".t4").first();
  await expect(kw).toHaveText(/import/);
  const dark = await kw.evaluate((e) => getComputedStyle(e).color);
  await expect(blocks.nth(1).locator(".t6", { hasText: "bump" })).toHaveCount(1);
  await expect(blocks.nth(2).locator(".t1")).toContainText(["# utf-8"]);
  expect(await blocks.first().textContent()).toBe(fx.ts.code.replace(/\n$/, "") + (/\n$/.test(await blocks.first().textContent() ?? "") ? "\n" : ""));
  await shot(page.locator(".md-codewrap").first(), "hl-desktop-dark-ts");
  await shot(page.locator(".md-codewrap").nth(1), "hl-desktop-dark-rust");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  expect(await kw.evaluate((e) => getComputedStyle(e).color)).not.toBe(dark);
  await shot(page.locator(".md-codewrap").nth(1), "hl-desktop-light-rust");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  expect(await page.evaluate(() => (window as any).__hl)).toEqual(expect.arrayContaining(["ts", "rust", "python"]));

  await page.getByTitle("Show side panel (Ctrl \\)").click();
  await page.getByTestId("files-tab").click();
  await page.locator('[data-path="src/"]').click();
  await page.locator('[data-path="src/cache.rs"]').click();
  await expect(page.locator(".file-view.hl .t5").first()).toHaveText(/use/);
  expect(await page.evaluate(() => (window as any).__hl)).toContain("src/cache.rs");
  await shot(page.getByTestId("files-pane"), "hl-file-viewer");
});

test("plain text without a shell or grammar stays readable", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false }, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp/demo", chats: [] }] }], activeProjectId: "p1" }));
  });
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await page.locator(".composer textarea").fill("mdcode");
  await page.locator(".composer textarea").press("Enter");
  await expect(page.locator(".md-code code")).toHaveCount(3);
  await expect(page.locator(".md-code code.hl")).toHaveCount(0);
  await expect(page.locator(".md-code code").first()).toContainText("countLines");
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("phone chat code blocks are highlighted", async ({ page }) => {
    const { uri } = await (await fetch("http://127.0.0.1:2431/pair")).json();
    await page.goto("/mobile.html");
    await page.getByTestId("m-name").fill("Pixel HL");
    await page.getByTestId("m-code").fill(uri);
    await page.getByTestId("m-pair-btn").click();
    await expect(page.getByTestId("m-status")).toHaveText("open");
    await shell(page);
    await page.getByTestId("m-chat").first().click();
    await page.getByTestId("m-input").fill("mdcode");
    await page.getByTestId("m-send").click();
    const block = page.locator(".md-code code.hl").last();
    await expect(block.locator(".t6", { hasText: "Println" })).toHaveCount(1);
    await expect(block.locator(".t3")).toHaveText("42");
    await block.scrollIntoViewIfNeeded();
    await shot(page, "hl-mobile");
  });
});
