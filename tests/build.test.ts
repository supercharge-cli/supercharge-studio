import { describe, expect, it } from "vitest";
import { build } from "vite";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

describe("build smoke", () => {
  it("bundles the UI", async () => {
    const outDir = resolve(__dirname, "../node_modules/.cache/smoke-dist");
    await build({ root: resolve(__dirname, ".."), logLevel: "silent", build: { outDir, emptyOutDir: true } });
    expect(existsSync(resolve(outDir, "index.html"))).toBe(true);
    expect(readFileSync(resolve(outDir, "index.html"), "utf8")).toContain("Supercharge Studio");
  }, 60000);
});
