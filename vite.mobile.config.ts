import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Mobile companion UI (Tauri 2 mobile), sharing src/ with the desktop app. */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-mobile", emptyOutDir: true, rollupOptions: { input: "mobile.html" } },
  server: { port: 5175, host: process.env.TAURI_DEV_HOST || "127.0.0.1", strictPort: true },
});
