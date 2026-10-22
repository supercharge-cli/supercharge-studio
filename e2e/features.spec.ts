import { expect, Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";

// New features: prompt library, @chat mentions, running list, MCP servers, schedules, export/share, text size, rules.
const OUT = process.env.FEATURE_SHOTS;
const shot = (page: Page, name: string) => (OUT ? page.screenshot({ path: `${OUT}/${name}.png` }) : Promise.resolve());
const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false };
const DATA = (extra: object = {}) => ({ settings: SETTINGS, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [{ id: "c1", title: "Fix login bug", createdAt: 2 }, { id: "c2", title: "Write release notes", createdAt: 1 }] }] }], activeProjectId: "p1", activeChatId: "c1", ...extra });

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

async function open(page: Page, extra: object = {}) {
  await page.addInitScript((d) => { if (!localStorage.getItem("supercharge-studio/v1")) localStorage.setItem("supercharge-studio/v1", JSON.stringify(d)); }, DATA(extra));
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}
const box = (page: Page) => page.locator(".composer textarea");
async function run(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Escape");
  await box(page).press("Enter");
}

test("prompt library: saved prompts are slash commands", async ({ page }) => {
  await open(page);
  await run(page, "/prompts");
  await expect(page.getByTestId("tools-screen")).toBeVisible();
  await page.getByTestId("prompt-add").click();
  await page.getByTestId("prompt-name").fill("Fix Issue");
  await expect(page.getByTestId("prompt-name")).toHaveValue("fix-issue");
  await page.getByTestId("prompt-text").fill("Fix issue $ARGUMENTS and add a test.");
  await page.getByTestId("prompt-add").click();
  await page.getByTestId("prompt-name").nth(1).fill("review");
  await page.getByTestId("prompt-text").nth(1).fill("Review the uncommitted changes.");
  await shot(page, "feat-prompts");
  await page.getByTestId("tools-close").click();
  await box(page).fill("/fix");
  await expect(page.locator(".cmenu")).toContainText("Prompts");
  await expect(page.locator(".cmenu")).toContainText("/fix-issue");
  await shot(page, "feat-prompts-menu");
  await box(page).fill("/fix-issue #42");
  await box(page).press("Escape");
  await box(page).press("Enter");
  await expect(page.locator(".thread")).toContainText("echo: Fix issue #42 and add a test.");
  await run(page, "/review");
  await expect(page.locator(".thread")).toContainText("echo: Review the uncommitted changes.");
});

test("@ mentions list other chats", async ({ page }) => {
  await open(page);
  await box(page).fill("compare with @Write");
  await expect(page.locator(".cmenu")).toContainText("Write release notes");
  await shot(page, "feat-mention-chats");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue(/@chat:c2 $/);
});

test("running list shows working chats and stops them", async ({ page }) => {
  await open(page);
  await run(page, "slow please");
  await page.getByTestId("runs-pill").click();
  await expect(page.getByTestId("run-row")).toContainText("working");
  await shot(page, "feat-running");
  await page.getByTestId("run-stop").click();
  await expect(page.getByTestId("run-row")).toHaveCount(0);
});

test("MCP servers, schedules and text size are saved", async ({ page }) => {
  await open(page);
  await run(page, "/mcp");
  await page.getByTestId("mcp-add").click();
  await page.getByTestId("mcp-name").fill("files");
  await page.getByTestId("mcp-command").fill("npx");
  await shot(page, "feat-mcp");
  await page.getByTestId("tools-schedules").click();
  await page.getByTestId("sched-add").click();
  await page.getByTestId("sched-prompt").fill("Check CI and summarize failures");
  await page.getByTestId("sched-kind").selectOption("at");
  await shot(page, "feat-schedules");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("supercharge-studio/v1")!));
  expect(saved.mcpServers).toEqual([{ name: "files", on: true, command: "npx" }]);
  expect(saved.schedules[0]).toMatchObject({ projectId: "p1", prompt: "Check CI and summarize failures", on: true, at: "09:00" });
  await page.getByTestId("tools-close").click();
  await run(page, "/font 18");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".thread")!).fontSize)).toBe("18px");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-appearance").click();
  await expect(page.getByTestId("font-size")).toHaveValue("18");
  await shot(page, "feat-text-size");
});

test("export to markdown and share link round trip", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await run(page, "hello export");
  await expect(page.locator(".thread")).toContainText("echo: hello export");
  const dl = page.waitForEvent("download");
  await run(page, "/export markdown");
  const file = await (await dl).path();
  expect(readFileSync(file!, "utf8")).toContain("**You:** hello export");
  await run(page, "/export link");
  await expect(page.getByTestId("notice")).toContainText("Share link copied");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^supercharge-studio:\/\/import#/);
  await box(page).fill(link);
  await box(page).press("Enter");
  await expect(page.locator(".thread")).toContainText("Imported from a share link");
  await expect(page.locator(".thread")).toContainText("echo: hello export");
  await shot(page, "feat-shared-chat");
});

test("rules editor in the desktop shell", async ({ page }) => {
  const files: Record<string, string> = { "project:AGENTS.md": "# Project rules\n\nUse bun." };
  const calls: string[] = [];
  await page.exposeFunction("__scInvoke", (cmd: string, a: any) => {
    calls.push(cmd);
    const k = `${a?.scope}:${a?.name}`;
    switch (cmd) {
      case "rules_list": return [["project", "AGENTS.md"], ["project", "AGENT.md"], ["project", "rules/style.md"], ["global", "AGENTS.md"]].map(([scope, name]) => ({ scope, name, path: `/x/${name}`, exists: `${scope}:${name}` in files }));
      case "rules_read": return files[k] ?? "";
      case "rules_write": files[k] = a.text; return null;
      default: return null;
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = { invoke: (c: string, a: any) => (window as any).__scInvoke(c, a), transformCallback: () => 1 };
  });
  await page.addInitScript((d) => localStorage.setItem("supercharge-studio/v1", JSON.stringify(d)), DATA());
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Type a command/).fill("open tools");
  await page.getByPlaceholder(/Type a command/).press("Enter");
  await page.getByTestId("tools-rules").click();
  await expect(page.getByTestId("rule-file")).toHaveCount(4);
  await page.getByTestId("rule-file").first().click();
  await expect(page.getByTestId("rule-text")).toHaveValue(/Use bun/);
  await page.getByTestId("rule-text").fill("# Project rules\n\nUse bun. Keep it small.");
  await page.getByTestId("rule-save").click();
  await expect.poll(() => files["project:AGENTS.md"]).toContain("Keep it small");
  await shot(page, "feat-rules");
});
