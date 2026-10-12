import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:5174", screenshot: "only-on-failure" },
  webServer: [
    { command: "npx vite-node scripts/fake-agent.ts -- --port 2421 --secret e2e", port: 2421, reuseExistingServer: false },
    { command: "npx vite-node scripts/fake-gateway.ts -- --port 2431", env: { RELAY_AUDIT: "1" }, port: 2431, reuseExistingServer: false },
    { command: "npx vite --port 5174 --strictPort", port: 5174, reuseExistingServer: false },
  ],
});
