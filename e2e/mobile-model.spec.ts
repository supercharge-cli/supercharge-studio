import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

// Keep runs hermetic: the live release check would open a blocking update sheet whenever a newer release is published.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
});

test("per-chat model and reasoning pickers follow load, changes, and live updates", async ({ page }) => {
  await page.route(/\/src\/mobile\/creds\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
    export const loadCreds = () => ({ deviceId: "d1", key: new Uint8Array(32), url: "ws://localhost", name: "Phone" });
    export const saveCreds = () => {};
    export const defaultDeviceName = () => "Phone";
    export const pendingCredsFromCode = async () => ({});
  ` }));
  await page.route(/\/src\/acp\/client\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
    const options = {
      s1: [{ id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }] }, { id: "reasoning_effort", category: "thought_level", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "xhigh", name: "Extra High" }] }, { id: "permission_mode", currentValue: "ask", options: [{ value: "ask", name: "Ask" }, { value: "always-approve", name: "Always approve" }] }],
      s2: [{ id: "model", currentValue: "deep", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }] }, { id: "permission_mode", currentValue: "ask", options: [{ value: "ask", name: "Ask" }, { value: "always-approve", name: "Always approve" }] }],
    };
    const modes = { s1: "default", s2: "default" };
    const modesFor = (sid) => ({ currentModeId: modes[sid], availableModes: [{ id: "default", name: "Agent" }, { id: "plan", name: "Plan" }] });
    export class AcpClient {
      constructor(opts) { this.opts = opts; window.mockClient = this; }
      async connect() { this.opts.onStateChange("open"); }
      async initialize() { return {}; }
      async listSessions() { return { sessions: [{ sessionId: "s1", title: "First", cwd: "/w" }, { sessionId: "s2", title: "Second", cwd: "/w" }], _meta: { projects: [] } }; }
      async loadSession(sid) { return { configOptions: options[sid], modes: modesFor(sid) }; }
      async newSession() { return { sessionId: "s2", configOptions: options.s2, modes: modesFor("s2") }; }
      async setMode(sid, modeId) { modes[sid] = modeId; window.lastMode = { sid, modeId }; this.opts.onUpdate(sid, { sessionUpdate: "current_mode_update", currentModeId: modeId }); }
      async setConfigOption(sid, id, value) {
        window.lastConfig = { sid, id, value };
        options[sid] = options[sid].map(o => o.id === id ? { ...o, currentValue: value } : o);
        return { configOptions: options[sid] };
      }
      close() {}
    }
    window.pushConfig = (sid, configOptions) => window.mockClient.opts.onUpdate(sid, { sessionUpdate: "config_option_update", configOptions });
    window.pushPlan = (sid) => window.mockClient.opts.onUpdate(sid, { sessionUpdate: "plan", entries: [{ content: "Verify result", status: "in_progress" }] });
    window.permissionAnswers = [];
    window.askPermission = (id) => window.mockClient.opts.onPermissionRequest({ sessionId: "s2", toolCall: { toolCallId: id, title: "Request " + id }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] }).then((outcome) => window.permissionAnswers.push({ id, outcome }));
  ` }));
  await page.goto("/mobile.html");
  await page.getByTestId("m-chat").first().click();
  await expect(page.getByTestId("m-chat-settings")).toContainText("Fast");
  await page.getByTestId("m-chat-settings").click();
  await expect(page.getByTestId("m-settings-sheet")).toBeVisible();
  await expect(page.getByTestId("m-model")).toContainText("Fast");
  await expect(page.getByTestId("m-thinking")).toHaveValue("0");
  await page.getByTestId("mode-trigger").click();
  await page.getByTestId("mode-plan").click();
  await expect(page.getByTestId("mode-trigger")).toContainText("Plan");
  expect(await page.evaluate(() => (window as any).lastMode)).toEqual({ sid: "s1", modeId: "plan" });
  await page.getByTestId("mode-trigger").click();
  await page.getByTestId("mode-permission-always-approve").click();
  await expect(page.getByTestId("mode-trigger")).toContainText("Always approve");
  await page.evaluate(() => (window as any).pushPlan("s1"));
  await expect(page.getByTestId("m-plan")).toContainText("Verify result");
  await page.getByTestId("m-model").click();
  await expect(page.getByTestId("m-config-picker")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search models" }).fill("dee");
  await expect(page.getByTestId("m-config-picker").getByRole("button", { name: /Deep/ })).toBeVisible();
  await expect(page.getByTestId("m-config-picker").getByRole("button", { name: /Fast/ })).toHaveCount(0);
  await page.getByTestId("m-config-picker").getByRole("button", { name: /Deep/ }).click();
  await expect(page.getByTestId("m-model")).toContainText("Deep");
  expect(await page.evaluate(() => (window as any).lastConfig)).toEqual({ sid: "s1", id: "model", value: "deep" });
  await page.getByTestId("m-thinking").fill("1");
  expect(await page.evaluate(() => (window as any).lastConfig)).toEqual({ sid: "s1", id: "reasoning_effort", value: "high" });
  await page.getByTestId("m-sheet-close").click();
  await page.getByTestId("m-back").click();
  await page.getByTestId("m-chat").nth(1).click();
  await page.getByTestId("m-chat-settings").click();
  await expect(page.getByTestId("m-model")).toContainText("Deep");
  await expect(page.getByTestId("m-thinking")).toHaveCount(0);
  await expect(page.getByTestId("mode-trigger")).toContainText("Agent");
  await expect(page.getByTestId("mode-trigger")).toContainText("Ask");
  await page.evaluate(() => (window as any).pushConfig("s1", [{ id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] }]));
  await expect(page.getByTestId("m-model")).toContainText("Deep");
  await page.evaluate(() => (window as any).pushConfig("s2", [{ id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] }]));
  await expect(page.getByTestId("m-model")).toContainText("Fast");
  await page.evaluate(() => (window as any).mockClient.opts.onReconnected());
  await expect(page.getByTestId("m-model")).toContainText("Deep");
  await expect(page.getByTestId("m-thread")).toBeVisible();
  await page.evaluate(() => { (window as any).askPermission("one"); (window as any).askPermission("two"); });
  await expect(page.getByTestId("m-perm")).toContainText("Request one");
  await page.getByTestId("m-perm").getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByTestId("m-perm")).toContainText("Request two");
  await page.getByTestId("m-perm").getByRole("button", { name: "Allow once" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).permissionAnswers.length)).toBe(2);
});

test("mobile: type a custom model id when the list is empty or missing the wanted model", async ({ page }) => {
  await page.route(/\/src\/mobile\/creds\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
    export const loadCreds = () => ({ deviceId: "d1", key: new Uint8Array(32), url: "ws://localhost", name: "Phone" });
    export const saveCreds = () => {};
    export const defaultDeviceName = () => "Phone";
    export const pendingCredsFromCode = async () => ({});
  ` }));
  await page.route(/\/src\/acp\/client\.ts(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: `
    const options = {
      s1: [{ id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] }],
    };
    export class AcpClient {
      constructor(opts) { this.opts = opts; window.mockClient = this; window.setupSaves = []; }
      async connect() { this.opts.onStateChange("open"); }
      async initialize() { return {}; }
      async listSessions() { return { sessions: [{ sessionId: "s1", title: "First", cwd: "/w" }], _meta: { projects: [] } }; }
      async loadSession(sid) { return { configOptions: options[sid], modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Agent" }] } }; }
      async setConfigOption(sid, id, value) {
        window.lastConfig = { sid, id, value };
        options[sid] = options[sid].map(o => o.id === id ? { ...o, currentValue: value } : o);
        return { configOptions: options[sid] };
      }
      async ext(method, params) {
        if (method === "_supercharge/setup" || method === "supercharge/setup") {
          window.setupSaves.push({ op: params.op, ...params });
          if (params.op === "status") return { providerId: "groq", baseUrl: "https://api.example/v1", format: "chat_completions", model: "fast", hasKey: true };
          if (params.op === "save") return { providerId: params.providerId, baseUrl: params.baseUrl, format: params.format, model: params.modelId, hasKey: true };
          return {};
        }
        return {};
      }
      close() {}
    }
  ` }));
  await page.goto("/mobile.html");
  await page.getByTestId("m-chat").first().click();
  await page.getByTestId("m-chat-settings").click();
  await page.getByTestId("m-model").click();
  await expect(page.getByTestId("m-config-picker")).toBeVisible();
  await page.getByTestId("m-model-custom-toggle").click();
  await page.getByTestId("m-model-custom-id").fill("phone/custom-1");
  await page.getByTestId("m-model-custom-name").fill("Phone Custom");
  await page.screenshot({ path: "/workspace/out/custom-model-mobile.png" });
  await page.getByTestId("m-model-custom-save").click();
  await expect(page.getByTestId("m-model")).toContainText("Phone Custom");
  const saves = await page.evaluate(() => (window as any).setupSaves.filter((s: any) => s.op === "save"));
  expect(saves).toEqual([expect.objectContaining({ modelId: "phone/custom-1", modelName: "Phone Custom", sessionId: "s1" })]);
  const customs = await page.evaluate(() => JSON.parse(localStorage.getItem("supercharge-mobile/custom-models")!));
  expect(customs).toEqual([{ id: "phone/custom-1", name: "Phone Custom" }]);
  await page.getByTestId("m-model").click();
  await expect(page.getByTestId("m-model-choice").filter({ hasText: "Phone Custom" })).toBeVisible();
});
