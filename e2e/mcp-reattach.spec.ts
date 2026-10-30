import { expect, test } from "@playwright/test";

// Keep runs hermetic: the live release check would open a blocking update banner whenever a newer release is published.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

// The browser tools (MCP) must stay attached across an agent restart without the user doing anything.
const SETTINGS = { bind: "127.0.0.1:2452", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: true };

test("browser MCP server is re-registered after the agent restarts mid-session", async ({ page }) => {
  await page.addInitScript((s) => {
    (window as any).__SC_TEST_MCP_URL = "http://127.0.0.1:9/mcp/test";
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "P", projects: [{ id: "p1", name: "mcp", cwd: "/srv/mcp", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  const ask = async (t: string) => { await page.locator(".composer textarea").fill(t); await page.locator(".composer textarea").press("Enter"); };
  await page.locator('[data-cwd="/srv/mcp"]').getByTestId("new-chat").click();
  await ask("mcpcheck one");
  await expect(page.locator(".bubble.agent").last()).toContainText("mcp attached: supercharge-studio-browser");
  await ask("dropconn");
  await expect(page.locator(".bubble.agent").last()).toContainText("restarting");
  await page.waitForTimeout(2500); // connection drops, client reconnects with backoff
  await expect(page.locator(".status")).toHaveText("open", { timeout: 15000 });
  await ask("mcpcheck two");
  await expect(page.locator(".bubble.agent").last()).toContainText("mcp attached: supercharge-studio-browser");
});

test("a chat opened before the agent handshake finishes still gets the browser tools", async ({ page }) => {
  const slow = { ...SETTINGS, bind: "127.0.0.1:2454" };
  await page.addInitScript((s) => {
    (window as any).__SC_TEST_MCP_URL = "http://127.0.0.1:9/mcp/test";
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "P", projects: [{ id: "p1", name: "mcp", cwd: "/srv/slow", chats: [] }] }], activeProjectId: "p1" }));
  }, slow);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  await page.locator('[data-cwd="/srv/slow"]').getByTestId("new-chat").click(); // initialize is still pending
  await page.locator(".composer textarea").fill("mcpcheck early");
  await page.locator(".composer textarea").press("Enter");
  await expect(page.locator(".bubble.agent").last()).toContainText("mcp attached: supercharge-studio-browser", { timeout: 10000 });
});
