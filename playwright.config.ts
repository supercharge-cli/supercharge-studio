import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:5174", screenshot: "only-on-failure" },
  webServer: [
    { command: "npx vite-node scripts/fake-agent.ts -- --port 2421 --secret e2e", port: 2421, reuseExistingServer: false },
    // One agent shared by several clients (headless server e2e).
    { command: "npx vite-node scripts/fake-agent.ts -- --port 2451 --secret e2e", port: 2451, reuseExistingServer: false, env: { FAKE_AGENT_SHARED: "1" } },
    { command: "npx vite-node scripts/fake-agent.ts -- --port 2452 --secret e2e", port: 2452, reuseExistingServer: false, env: { FAKE_AGENT_CLI: "1", FAKE_AGENT_REPORT: "/tmp/scs-cli-agent.json" } },
    { command: "npx vite-node scripts/fake-gateway.ts -- --port 2431", env: { RELAY_AUDIT: "1" }, port: 2431, reuseExistingServer: false },
    { command: "npx vite --port 5174 --strictPort", port: 5174, reuseExistingServer: false },
  ],
});
