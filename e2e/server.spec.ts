import { expect, test } from "@playwright/test";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Headless server end to end: phone UI ↔ (relay) ↔ supercharge-studio-server ↔ ACP agent.
 * Uses a shared-state fake agent (2451) and the reference relay started by the gateway double (2432).
 * Skipped when the server binary has not been built (cargo build --release in server/).
 */
const BIN = process.env.SCS_BIN ?? join(process.cwd(), "server/target/release/supercharge-studio-server" + (process.platform === "win32" ? ".exe" : ""));
test.describe.configure({ mode: "serial" });
test.skip(!existsSync(BIN), "server binary not built");
test.use({ viewport: { width: 390, height: 844 } });

let server: ChildProcess | null = null;
let data = "";
test.beforeAll(async () => {
  test.setTimeout(60000);
  data = mkdtempSync(join(tmpdir(), "scs-"));
  server = spawn(BIN, ["run", "--bind", "127.0.0.1:2440", "--public-url", "ws://127.0.0.1:9/gw", "--agent", "ws://127.0.0.1:2451", "--agent-secret", "e2e", "--relay", "ws://127.0.0.1:2432", "--data-dir", data, "--control", "127.0.0.1:2441", "--name", "CI Server"], { stdio: ["ignore", "inherit", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not reach the relay")), 45000);
    const t0 = Date.now();
    let log = ""; // stderr can arrive split mid-line ("relay: " + "online")
    server!.stderr!.on("data", (d) => { process.stderr.write(`[+${Date.now() - t0}ms] ` + d); log += String(d); if (log.includes("relay: online")) { clearTimeout(t); resolve(); } });
  });
});
test.afterAll(() => server?.kill());

async function pairCode(): Promise<{ uri: string; done: Promise<number> }> {
  const p = spawn(BIN, ["pair", "--yes", "--data-dir", data, "--control", "127.0.0.1:2441"], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<number>((r) => p.on("exit", (c) => r(c ?? 1)));
  const uri = await new Promise<string>((resolve) => {
    let buf = "";
    p.stdout!.on("data", (d) => { buf += d; const m = buf.match(/scstudio:\/\/pair\?\S+/); if (m) resolve(m[0]); });
  });
  return { uri, done };
}

async function seedSession() {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket("ws://127.0.0.1:2451/ws?server-key=e2e");
  await new Promise((r) => ws.once("open", r));
  const call = (id: number, method: string, params: unknown) => new Promise((r) => { ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id === id) r(m.result); }); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  await call(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  await call(2, "session/new", { cwd: "/srv/app", mcpServers: [] });
  ws.close();
}

test("pairs through the relay with the direct route unreachable, then chats with the agent", async ({ page }) => {
  await seedSession();
  const { uri, done } = await pairCode();
  expect(uri).toContain("&r=");
  await page.goto("/mobile.html");
  await page.getByTestId("m-name").fill("Relay Phone");
  await page.getByTestId("m-code").fill(uri);
  await page.getByTestId("m-pair-btn").click();
  await expect(page.getByTestId("m-list")).toBeVisible({ timeout: 15000 });
  expect(await done).toBe(0);
  await expect(page.getByTestId("m-route")).toHaveText("relay");
  // Chat with the agent through the server's ACP bridge.
  await page.getByTestId("m-chat").first().click();
  await page.getByTestId("m-input").fill("hello server");
  await page.getByTestId("m-send").click();
  await expect(page.locator(".bubble.agent").last()).toHaveText("echo: hello server", { timeout: 10000 });
  const stats = await (await fetch("http://127.0.0.1:2431/relay-stats")).json();
  expect(stats.lanes).toBeGreaterThanOrEqual(2);
  expect(stats.plaintextSeen).toBe(false);
});
