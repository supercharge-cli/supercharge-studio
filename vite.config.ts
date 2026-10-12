import { defineConfig, mergeConfig } from "vite";
import react from "@vitejs/plugin-react";
import { shared } from "./vite.shared";

export default defineConfig(({ command }) =>
  mergeConfig(shared(command), {
    plugins: [react()],
    server: { port: 5173, host: "127.0.0.1" },
  }),
);
