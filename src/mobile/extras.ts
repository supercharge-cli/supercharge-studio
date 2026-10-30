/** The phone's on-demand pieces in one lazy chunk (one gzip stream packs tighter than several small files). */
export * from "../components/ProviderSetup";
export { default } from "../components/ProviderSetup";
export { default as Pair } from "./pair";
export { SearchIndex } from "../lib/searchIndex";
// Shared modules the phone build points here (see vite.mobile.config.ts).
export { ContextWindowPop } from "../components/ContextWindowPop";
export { downscaleImage } from "../lib/imageResize";
