import type { UserConfig } from "vite";

/**
 * Builds, dev and tests render with Preact's React-compatible runtime (~4x smaller than
 * react-dom). Set STUDIO_REACT=1 to opt out.
 */
const compat = process.env.STUDIO_REACT !== "1";
export const shared = (_command: "build" | "serve"): UserConfig => ({
  resolve: compat ? {
    alias: [
      { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
      { find: /^react$/, replacement: "preact/compat" },
    ],
  } : {},
  build: {
    target: "es2022",
    // terser packs ~4% smaller (gzip) than the default minifier; that headroom keeps features inside the budgets.
    minify: "terser",
    terserOptions: { ecma: 2020, module: true, compress: { passes: 3, pure_getters: true }, format: { comments: false } },
    cssMinify: true, modulePreload: { polyfill: false }, reportCompressedSize: false },
});
