import { expect, test } from "@playwright/test";

// Phone side of the new features: saved prompts as / pills, notification answers and the widget feed.
const GW = "http://127.0.0.1:2431";
const OUT = process.env.FEATURE_SHOTS;
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

async function pair(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as any).__widget = [];
    (window as any).SuperchargeAndroid = { widget: (j: string) => (window as any).__widget.push(JSON.parse(j)), keepAlive() {}, notify() {}, notifyPermission() {} };
  });
  const { uri } = await (await fetch(`${GW}/pair`)).json();
  await page.goto("/mobile.html");
  await page.getByTestId("m-name").fill("Pixel Test");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-status")).toHaveText("open");
}

test("saved prompts show as / suggestions on the phone", async ({ page }) => {
  await pair(page);
  await page.getByTestId("m-chat").first().click();
  await page.getByTestId("m-input").fill("/");
  await expect(page.getByTestId("m-prompt")).toHaveText(["/review", "/fix-issue"]);
  await page.getByTestId("m-input").fill("/fi");
  await expect(page.getByTestId("m-prompt")).toHaveText(["/fix-issue"]);
  if (OUT) await page.screenshot({ path: `${OUT}/feat-mobile-prompts.png` });
  await page.getByTestId("m-prompt").click();
  await expect(page.getByTestId("m-input")).toHaveValue("/fix-issue ");
});

test("Allow from a notification answers the approval and the widget follows", async ({ page }) => {
  await pair(page);
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-thread")).toBeVisible();
  await fetch(`${GW}/perm`);
  await expect(page.getByTestId("m-perm")).toContainText("Delete dist");
  await expect.poll(() => page.evaluate(() => (window as any).__widget.at(-1)?.waiting)).toBe(1);
  if (OUT) await page.screenshot({ path: `${OUT}/feat-mobile-approval.png` });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("supercharge:answer", { detail: { key: "s1:t1", allow: true } })));
  await expect(page.getByTestId("m-perm")).toHaveCount(0);
  await expect.poll(async () => (await fetch(`${GW}/perm-result`)).json()).toEqual({ outcome: "selected", optionId: "ok" });
  await expect.poll(() => page.evaluate(() => (window as any).__widget.at(-1))).toMatchObject({ waiting: 0, linked: true });
});

async function pairRecording(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const bg: any = ((window as any).__bg = { alive: [] as boolean[], status: [] as string[][], notes: [] as string[][] });
    (window as any).SuperchargeAndroid = {
      widget() {}, keepAlive: (on: boolean) => bg.alive.push(on), status: (...a: string[]) => bg.status.push(a),
      notify: (...a: any[]) => bg.notes.push(a.map(String)), notifyPermission: (...a: any[]) => bg.notes.push(a.map(String)),
    };
  });
  const { uri } = await (await fetch(`${GW}/pair`)).json();
  await page.goto("/mobile.html");
  await page.getByTestId("m-name").fill("Pixel Test");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-status")).toHaveText("open");
}
const bg = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__bg);

test("background mode: keep-alive with a live status line, approvals from it, then stops", async ({ page }) => {
  await pairRecording(page);
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-thread")).toBeVisible();
  await page.getByTestId("m-input").fill("bgwork please");
  await page.getByTestId("m-send").click();
  await expect.poll(async () => (await bg(page)).alive.at(-1)).toBe(true);
  await expect.poll(async () => (await bg(page)).status.map((s: string[]) => s[2])).toEqual(expect.arrayContaining(["Thinking…", "Editing login.ts"]));
  // The approval shows on the live notification with its key (Allow / Deny there).
  await expect.poll(async () => (await bg(page)).status.at(-1)).toEqual(["s1", "Fix login bug", "Waiting for approval: Run bun test", "s1:b2"]);
  await expect(page.getByTestId("m-perm")).toBeVisible();
  if (OUT) await page.screenshot({ path: `${OUT}/feat-mobile-bg-approval.png` });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("supercharge:answer", { detail: { key: "s1:b2", allow: true } })));
  await expect(page.getByTestId("m-thread")).toContainText("Tests pass.");
  const b = await bg(page);
  expect(b.status.map((s: string[]) => s[2])).toContain("Working…");
  // Idle again: the service stops (the page sent keepAlive(false)).
  await expect.poll(async () => (await bg(page)).alive.at(-1)).toBe(false);
});

test("background mode: a turn started on the computer keeps the phone connected and says when it is done", async ({ page }) => {
  await pairRecording(page);
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-thread")).toBeVisible();
  try {
    await fetch(`${GW}/busy?sid=s2&on=1`);
    await expect.poll(async () => (await bg(page)).alive.at(-1)).toBe(true);
  } finally {
    await fetch(`${GW}/busy?sid=s2&on=0`);
  }
  await expect.poll(async () => (await bg(page)).alive.at(-1)).toBe(false);
  // Finished in another chat than the open one: a "Done" alert for it.
  await expect.poll(async () => (await bg(page)).notes.find((n: string[]) => n[0] === "s2")?.[1]).toBe("Done · Write release notes");
});
