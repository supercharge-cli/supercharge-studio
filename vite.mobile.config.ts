import { defineConfig, mergeConfig } from "vite";
import react from "@vitejs/plugin-react";
import { shared } from "./vite.shared";

/** Mobile companion UI (Tauri 2 mobile), sharing src/ with the desktop app. */
export default defineConfig(({ command }) =>
  mergeConfig(shared(command), {
    plugins: [react()],
    build: { outDir: "dist-mobile", emptyOutDir: true, rollupOptions: {
      input: "mobile.html",
      // The Tauri plugins (QR scan, deep links) load together on demand: one chunk, not three.
      output: { manualChunks: (id) => (id.includes("@tauri-apps/") ? "tauri" : undefined) },
    } },
    server: { port: 5175, host: process.env.TAURI_DEV_HOST || "127.0.0.1", strictPort: true },
  }),
);
