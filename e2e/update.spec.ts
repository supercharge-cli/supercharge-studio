import { expect, Page, test } from "@playwright/test";

// In-app updates with a mocked native updater: banner, background progress, ready prompt, restart.
const REL = "https://github.com/supercharge-cli/supercharge-studio/releases/download/v9.9.9/";
const PAGE = "https://github.com/supercharge-cli/supercharge-studio/releases/tag/v9.9.9";
const ASSETS = ["supercharge-studio-linux-x86_64.rpm", "Supercharge-Studio-linux-x86_64.AppImage", "Supercharge-Studio-linux-x86_64.AppImage.sig", "supercharge-studio-android-arm64.apk", "latest.json", "SHA256SUMS"];
const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false };

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ tag_name: "v9.9.9", html_url: PAGE, assets: ASSETS.map((name) => ({ name, browser_download_url: REL + name })) }) }));
  await page.addInitScript(() => {
    (window as any).__opened = [];
    window.open = ((u: string) => { (window as any).__opened.push(u); return null; }) as any;
  });
});

/** Boot the desktop UI in web mode, then become the desktop shell with a mocked updater. */
async function bootDesktop(page: Page, format: string) {
  await page.clock.install();
  await page.addInitScript((s) => {
    localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
  // Plain web build: no updater, so the banner only offers the manual download.
  const banner = page.getByTestId("update-banner");
  await expect(banner).toContainText("Supercharge Studio 9.9.9 is available.");
  await banner.getByRole("button", { name: "Download manually" }).click();
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([REL + "Supercharge-Studio-linux-x86_64.AppImage"]);
  await banner.getByRole("button", { name: "Later" }).click();
  await expect(banner).toBeHidden();
  await page.evaluate((format) => {
    const u: any = { calls: [], cbs: {}, listeners: {} };
    (window as any).__upd = u;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: (cb: any) => { const id = Object.keys(u.cbs).length + 1; u.cbs[id] = cb; return id; },
      invoke: async (cmd: string, args?: any) => {
        u.calls.push({ cmd, args });
        if (cmd === "host_package") return format;
        if (cmd === "plugin:event|listen") { u.listeners[args.event] = args.handler; return 1; }
        if (cmd === "update_download") return new Promise((ok, no) => { u.done = ok; u.fail = no; });
        return null;
      },
    };
    u.emit = (event: string, payload: unknown) => u.cbs[u.listeners[event]]?.({ event, id: 1, payload });
  }, format);
  // The 6-hour re-check finds the update again, now with the updater available.
  await page.clock.fastForward("06:00:00");
  await expect(banner).toHaveAttribute("data-state", "downloading");
  await expect.poll(() => page.evaluate(() => !!(window as any).__upd.listeners["update://progress"])).toBe(true);
  return banner;
}

const calls = (page: Page, cmd: string) => page.evaluate((cmd) => (window as any).__upd.calls.filter((c: any) => c.cmd === cmd).map((c: any) => c.args ?? null), cmd);

test("rpm install: progress, verified package install, Update ready, Restart relaunches", async ({ page }) => {
  const banner = await bootDesktop(page, "rpm");
  await expect(banner).toContainText("Downloading Supercharge Studio 9.9.9");
  expect(await calls(page, "update_download")).toEqual([{ pkg: { url: REL + "supercharge-studio-linux-x86_64.rpm", name: "supercharge-studio-linux-x86_64.rpm", format: "rpm" } }]);
  await page.evaluate(() => (window as any).__upd.emit("update://progress", { done: 50, total: 100 }));
  await expect(page.getByTestId("update-progress")).toHaveJSProperty("value", 0.5);
  await page.evaluate(() => (window as any).__upd.done("native"));
  await expect(banner).toHaveAttribute("data-state", "ready");
  await expect(banner).toContainText("Update ready — restart to use Supercharge Studio 9.9.9.");
  await expect(banner.getByRole("button", { name: "Later" })).toBeVisible();
  await banner.getByRole("button", { name: "Restart" }).click();
  await expect.poll(() => calls(page, "update_restart")).toHaveLength(1);
});

test("signed bundle (AppImage): installed in place, Restart goes through the process plugin", async ({ page }) => {
  const banner = await bootDesktop(page, "appimage");
  expect(await calls(page, "update_download")).toEqual([{ pkg: null }]);
  await page.evaluate(() => (window as any).__upd.done("process"));
  await banner.getByRole("button", { name: "Restart" }).click();
  await expect.poll(() => calls(page, "plugin:process|restart")).toHaveLength(1);
  expect(await calls(page, "update_restart")).toHaveLength(0);
});

test("a failed update falls back to Download manually", async ({ page }) => {
  const banner = await bootDesktop(page, "rpm");
  await page.evaluate(() => (window as any).__upd.fail("checksum mismatch for supercharge-studio-linux-x86_64.rpm"));
  await expect(banner).toHaveAttribute("data-state", "error");
  await expect(banner).toContainText("Couldn't install Supercharge Studio 9.9.9: checksum mismatch");
  await banner.getByRole("button", { name: "Download manually" }).click();
  expect(await page.evaluate(() => (window as any).__opened.at(-1))).toBe(REL + "supercharge-studio-linux-x86_64.rpm");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  /** Pair with the fake gateway (the update sheet shows on the paired app). */
  async function openPhone(page: Page) {
    const { uri } = await (await fetch("http://127.0.0.1:2431/pair")).json();
    await page.goto("/mobile.html");
    await page.getByTestId("m-name").fill("Pixel Test");
    await page.getByTestId("m-code").fill(uri);
    await page.getByTestId("m-pair-btn").click();
    await expect(page.getByTestId("m-list")).toBeAttached();
  }

  test("Android downloads in the background, then Restart opens the system installer", async ({ page }) => {
    await page.addInitScript(() => {
      const a: any = { dl: [], installs: 0 };
      (window as any).__android = a;
      (window as any).SuperchargeAndroid = { keepAlive() {}, notify() {}, downloadUpdate: (...x: string[]) => a.dl.push(x), installUpdate: () => { a.installs++; } };
    });
    await openPhone(page);
    const sheet = page.getByTestId("m-update");
    await expect(sheet).toContainText("Update 9.9.9");
    expect(await page.evaluate(() => (window as any).__android.dl)).toEqual([[REL + "supercharge-studio-android-arm64.apk", REL + "latest.json", "supercharge-studio-android-arm64.apk"]]);
    const send = (detail: unknown) => page.evaluate((d) => window.dispatchEvent(new CustomEvent("supercharge:update", { detail: d })), detail);
    await send({ p: 0.4 });
    await expect(page.getByTestId("m-update-progress")).toHaveJSProperty("value", 0.4);
    // Later hides the sheet; the download keeps going and the sheet comes back when it is ready.
    await sheet.getByRole("button", { name: "Later" }).click();
    await expect(sheet).toBeHidden();
    await send({ ready: true, hide: 0 });
    await expect(sheet).toContainText("Update ready");
    await sheet.getByRole("button", { name: "Restart" }).click();
    expect(await page.evaluate(() => (window as any).__android.installs)).toBe(1);
    await send({ err: "Allow installs from Supercharge Studio, then tap Restart again." });
    await expect(sheet).toContainText("Allow installs from Supercharge Studio");
    await expect(sheet.getByRole("button", { name: "Restart" })).toBeVisible();
  });

  test("a failed phone download offers the APK directly", async ({ page }) => {
    await page.addInitScript(() => { (window as any).SuperchargeAndroid = { keepAlive() {}, notify() {}, downloadUpdate() {}, installUpdate() {} }; });
    await openPhone(page);
    const sheet = page.getByTestId("m-update");
    await expect(sheet).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("supercharge:update", { detail: { p: null, err: "Download failed: checksum mismatch", hide: 0 } })));
    await sheet.getByRole("button", { name: "Download manually" }).click();
    expect(await page.evaluate(() => (window as any).__opened)).toEqual([REL + "supercharge-studio-android-arm64.apk"]);
  });

  test("iOS (no installer bridge) links to the release page", async ({ page }) => {
    await openPhone(page);
    const sheet = page.getByTestId("m-update");
    await sheet.getByRole("button", { name: "Install" }).click();
    expect(await page.evaluate(() => (window as any).__opened)).toEqual([PAGE]);
  });
});
