import { defineConfig, mergeConfig } from "vite";
import react from "@vitejs/plugin-react";
import { shared, stripTestIds } from "./vite.shared";

export default defineConfig(({ command }) =>
  mergeConfig(shared(command), {
    // Release builds drop the data-testid hooks, like the phone build.
    plugins: [react(command === "build" ? { babel: { plugins: [stripTestIds] } } : {})],
    server: { port: 5173, host: "127.0.0.1" },
  }),
);
