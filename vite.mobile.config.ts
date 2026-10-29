import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import react from "@vitejs/plugin-react";
import { shared } from "./vite.shared";

/** Mobile companion UI (Tauri 2 mobile), sharing src/ with the desktop app. */
export default defineConfig(({ command }) =>
  mergeConfig(shared(command), {
    plugins: [react(), {
      // Desktop-only icons stay out of the phone bundle.
      name: "mobile-icons", enforce: "pre",
      resolveId: (id: string, from?: string) => (/\/iconsDesktop(\.ts)?$/.test(id) && from?.includes("/src/components/") ? fileURLToPath(new URL("./src/components/iconsDesktop.mobile.ts", import.meta.url)) : null),
    }],
    build: { outDir: "dist-mobile", emptyOutDir: true, rollupOptions: {
      input: "mobile.html",
    } },
    server: { port: 5175, host: process.env.TAURI_DEV_HOST || "127.0.0.1", strictPort: true },
  }),
);
