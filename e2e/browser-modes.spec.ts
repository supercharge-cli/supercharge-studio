import { expect, Page, test } from "@playwright/test";

const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false };
const PAGE = "data:text/html," + encodeURIComponent(`<body style="font:16px system-ui;margin:0"><nav style="display:flex;gap:24px;padding:18px 32px;background:#111;color:#fff"><b>Acme</b><span>Pricing</span><span>Docs</span></nav><main style="padding:48px 32px"><h1>Ship faster</h1><p>Layout at the full desktop width.</p><button class="primary" style="padding:10px 18px;background:#7c5cff;color:#fff;border:0">Get started</button></main></body>`);

async function boot(page: Page) {
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.route("https://api.github.com/**", (r) => r.abort());
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}

test("computer mode shows a desktop-size page scaled to fit and returns to the panel", async ({ page }) => {
  await boot(page);
  await page.getByTitle("Show side panel (Ctrl \\)").click();
  await page.getByLabel("Address").fill(PAGE);
  await page.getByLabel("Address").press("Enter");
  await page.getByTestId("computer-toggle").click();
  await expect(page.getByTestId("computer-mode")).toBeVisible();
  await page.getByLabel("Viewport size").selectOption("1920x1080");
  const stage = (await page.locator(".bm-stage").boundingBox())!;
  expect(Math.abs(stage.width / stage.height - 1920 / 1080)).toBeLessThan(0.01);
  expect(stage.width).toBeLessThan(1360);
  await expect(page.getByTestId("computer-zoom")).toHaveText(`${Math.round((stage.width / 1920) * 100)}%`);
  await page.screenshot({ path: "/workspace/out/bm-computer.png" });
  await page.getByLabel("Custom size").fill("1280x800");
  await page.getByLabel("Custom size").press("Enter");
  await expect(page.getByLabel("Viewport size")).toHaveValue("1280x800");
  await page.getByTestId("computer-exit").click();
  await expect(page.getByTestId("computer-mode")).toHaveCount(0);
  await expect(page.locator(".webslot iframe")).toHaveCount(1);
});

test("dev drawer shows captured console and network; design picks become composer attachments", async ({ page }) => {
  await boot(page);
  // Pretend to be the desktop shell: the side browser answers with captured entries and one picked element.
  await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 1360; c.height = 800;
    const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.fillRect(0, 0, 1360, 800); g.fillStyle = "#7c5cff"; g.fillRect(32, 160, 140, 40); g.fillStyle = "#fff"; g.font = "16px sans-serif"; g.fillText("Get started", 52, 186);
    const png = c.toDataURL("image/png").split(",")[1];
    let picked = false;
    const ok = (value: unknown) => JSON.stringify({ ok: true, value });
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd: string, args: any) => {
      if (cmd === "browser_screenshot") return png;
      if (cmd !== "browser_eval") return null;
      const s: string = args.script;
      if (s.includes("window.__scDev")) return ok({ id: "page1", seq: 5, logs: [
        { seq: 1, t: Date.now(), level: "log", text: "app booted in 412 ms" },
        { seq: 2, t: Date.now(), level: "warn", text: "Deprecated prop `size` on <Button>" },
        { seq: 3, t: Date.now(), level: "error", kind: "uncaught", text: "TypeError: cannot read properties of undefined (reading 'price')", source: "http://localhost:5173/src/Pricing.tsx:42:17" },
      ], net: [
        { seq: 4, t: Date.now(), method: "GET", url: "http://localhost:5173/api/plans", status: 200, ms: 38 },
        { seq: 5, t: Date.now(), method: "POST", url: "http://localhost:5173/api/checkout", status: 500, ms: 120 },
      ] });
      if (s.includes("__scPick; if (!P)")) {
        if (picked) return ok({ commit: 1, picks: [], exit: false });
        picked = true;
        return ok({ commit: 1, exit: false, picks: [{ selector: "main > button.primary", tag: "button", text: "Get started", html: '<button class="primary">Get started</button>', box: { x: 32, y: 160, width: 140, height: 40 }, styles: { "border-radius": "0px", "background-color": "rgb(124, 92, 255)" }, source: "src/Hero.tsx:18", page: { url: "http://localhost:5173/", title: "Acme", width: 1360, height: 800, scrollY: 0 } }] });
      }
      return ok(true);
    } };
  });
  await page.getByTitle("Show side panel (Ctrl \\)").click();
  await page.getByTestId("dev-toggle").click();
  await expect(page.getByTestId("dev-drawer")).toContainText("TypeError", { timeout: 5000 });
  await expect(page.getByTestId("dev-drawer")).toContainText("Deprecated prop");
  await page.screenshot({ path: "/workspace/out/bm-dev-console.png" });
  await page.getByTestId("dev-drawer").getByRole("button", { name: /Network/ }).click();
  await expect(page.getByTestId("dev-drawer")).toContainText("/api/checkout");
  await page.getByLabel("Level").selectOption("error");
  await expect(page.getByTestId("dev-drawer")).not.toContainText("/api/plans");
  await page.screenshot({ path: "/workspace/out/bm-dev-network.png" });
  await page.getByTestId("dev-toggle").click();
  await page.getByTestId("design-toggle").click();
  await expect(page.getByTestId("design-hint")).toBeVisible();
  await expect(page.getByTestId("attachment")).toHaveCount(2, { timeout: 5000 });
  await expect(page.getByTestId("attachments")).toContainText("button.primary.md");
  await expect(page.getByTestId("attachments")).toContainText("button.primary.png");
  await page.locator(".composer textarea").fill("make this button rounded");
  await page.screenshot({ path: "/workspace/out/bm-design.png" });
});
