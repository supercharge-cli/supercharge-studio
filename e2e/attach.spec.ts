import { expect, Page, test } from "@playwright/test";

// Keep runs hermetic: the live release check would open a blocking update banner whenever a newer release is published.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

const SETTINGS = { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false, onboarded: true };

async function boot(page: Page) {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("supercharge-studio/v1"))
      localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: s, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd: "/tmp", chats: [] }] }], activeProjectId: "p1" }));
  }, SETTINGS);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("attach button sends an image block and an embedded text file", async ({ page }) => {
  await boot(page);
  await page.getByTestId("attach-input").setInputFiles([
    { name: "dot.png", mimeType: "image/png", buffer: PNG },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# hi") },
  ]);
  await expect(page.getByTestId("attachment")).toHaveCount(2);
  await expect(page.getByTestId("attachment").first().locator("img")).toBeVisible();
  await page.locator(".composer textarea").fill("look");
  await page.locator(".composer textarea").press("Enter");
  await expect(page.getByTestId("attachment")).toHaveCount(0);
  await expect(page.getByTestId("bubble-attachments").last()).toContainText("dot.png");
  await expect(page.locator(".bubble.agent").last()).toContainText("attachments: image(image/png) resource(notes.md,text)");
  await expect(page.locator(".bubble.agent").last()).toContainText("echo: look");
});

test("attachments can be removed, pasted, dropped, and oversized files are refused", async ({ page }) => {
  await boot(page);
  await page.getByTestId("attach-input").setInputFiles([{ name: "a.bin", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3]) }]);
  await page.getByTestId("attachment-remove").click();
  await expect(page.getByTestId("attachment")).toHaveCount(0);
  // Paste an image into the message box.
  await page.locator(".composer textarea").evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "clip.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("attachment")).toHaveCount(1);
  // Drop a file on the composer.
  await page.getByTestId("composer-wrap").evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "drop.txt", { type: "text/plain" }));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("attachment")).toHaveCount(2);
  // 9 MB image is over the image limit.
  await page.getByTestId("attach-input").setInputFiles([{ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(9 * 1024 * 1024, 1) }]);
  await expect(page.getByTestId("attach-error")).toContainText("images can be up to");
  await expect(page.getByTestId("attachment")).toHaveCount(2);
  // Attachments alone (no text) can be sent.
  await page.locator(".composer button[aria-label=Send]").click();
  await expect(page.locator(".bubble.agent").last()).toContainText("attachments: image(image/png) resource(drop.txt,text)");
});
