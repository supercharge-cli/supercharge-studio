import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("per-chat model and reasoning pickers follow load, changes, and live updates", async ({ page }) => {
  await page.route(/\/src\/mobile\/creds\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
    export const loadCreds = () => ({ deviceId: "d1", key: new Uint8Array(32), url: "ws://localhost", name: "Phone" });
    export const saveCreds = () => {};
    export const defaultDeviceName = () => "Phone";
    export const pendingCredsFromCode = async () => ({});
  ` }));
  await page.route(/\/src\/acp\/client\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
    const options = {
      s1: [{ id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }] }, { id: "reasoning_effort", currentValue: "low", options: [{ value: "low" }, { value: "high" }] }],
      s2: [{ id: "model", currentValue: "deep", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }] }],
    };
    export class AcpClient {
      constructor(opts) { this.opts = opts; window.mockClient = this; }
      async connect() { this.opts.onStateChange("open"); }
      async initialize() { return {}; }
      async listSessions() { return { sessions: [{ sessionId: "s1", title: "First", cwd: "/w" }, { sessionId: "s2", title: "Second", cwd: "/w" }], _meta: { projects: [] } }; }
      async loadSession(sid) { return { configOptions: options[sid] }; }
      async newSession() { return { sessionId: "s2", configOptions: options.s2 }; }
      async setConfigOption(sid, id, value) {
        window.lastConfig = { sid, id, value };
        options[sid] = options[sid].map(o => o.id === id ? { ...o, currentValue: value } : o);
        return { configOptions: options[sid] };
      }
      close() {}
    }
    window.pushConfig = (sid, configOptions) => window.mockClient.opts.onUpdate(sid, { sessionUpdate: "config_option_update", configOptions });
  ` }));
  await page.goto("/mobile.html");
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-model")).toContainText("Fast");
  await expect(page.getByTestId("m-reasoning")).toContainText("low");
  await page.getByTestId("m-model").click();
  await expect(page.getByTestId("m-config-picker")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search models" }).fill("dee");
  await expect(page.getByTestId("m-config-picker").getByRole("button", { name: /Deep/ })).toBeVisible();
  await expect(page.getByTestId("m-config-picker").getByRole("button", { name: /Fast/ })).toHaveCount(0);
  await page.getByTestId("m-config-picker").getByRole("button", { name: /Deep/ }).click();
  await expect(page.getByTestId("m-model")).toContainText("Deep");
  expect(await page.evaluate(() => (window as any).lastConfig)).toEqual({ sid: "s1", id: "model", value: "deep" });
  await page.getByTestId("m-reasoning").click();
  await page.getByRole("button", { name: "high" }).click();
  expect(await page.evaluate(() => (window as any).lastConfig)).toEqual({ sid: "s1", id: "reasoning_effort", value: "high" });
  await page.getByTestId("m-back").click();
  await page.getByTestId("m-chat").nth(1).click();
  await expect(page.getByTestId("m-model")).toContainText("Deep");
  await expect(page.getByTestId("m-reasoning")).toHaveCount(0);
  await page.evaluate(() => (window as any).pushConfig("s1", [{ id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] }]));
  await expect(page.getByTestId("m-model")).toContainText("Deep");
  await page.evaluate(() => (window as any).pushConfig("s2", [{ id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] }]));
  await expect(page.getByTestId("m-model")).toContainText("Fast");
  await page.evaluate(() => (window as any).mockClient.opts.onReconnected());
  await expect(page.getByTestId("m-model")).toContainText("Deep");
  await expect(page.getByTestId("m-thread")).toBeVisible();
});
