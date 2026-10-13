/** Color themes. Each id maps to a `[data-theme="id"]` block in styles.css. */
export type ThemeInfo = { id: string; name: string; dark: boolean; swatch: [string, string, string] };
export const THEMES: ThemeInfo[] = [
  { id: "dark", name: "Dark", dark: true, swatch: ["#0d0e11", "#16181d", "#7c5cff"] },
  { id: "midnight", name: "Midnight", dark: true, swatch: ["#0a0f1c", "#111a2e", "#4c8dff"] },
  { id: "forest", name: "Forest", dark: true, swatch: ["#0c1210", "#121b17", "#3ccf8e"] },
  { id: "ember", name: "Ember", dark: true, swatch: ["#140f0d", "#1d1613", "#ff7a45"] },
  { id: "contrast", name: "High contrast", dark: true, swatch: ["#000000", "#0b0b0b", "#1f7cff"] },
  { id: "light", name: "Light", dark: false, swatch: ["#ffffff", "#f3f4f7", "#6a48f5"] },
  { id: "paper", name: "Paper", dark: false, swatch: ["#fbf8f1", "#f2ede1", "#b4572e"] },
  { id: "sky", name: "Sky", dark: false, swatch: ["#f6f9fe", "#eaf1fb", "#1e6ef0"] },
  { id: "rose", name: "Rose", dark: false, swatch: ["#fdf7f8", "#f8ebee", "#d6336c"] },
];
export const SYSTEM_THEME = { id: "system", name: "System", dark: true, swatch: ["#0d0e11", "#ffffff", "#7c5cff"] as [string, string, string] };
export const themeList: ThemeInfo[] = [SYSTEM_THEME, ...THEMES];
/** Resolve a saved theme id to a concrete one (unknown ids fall back to dark). */
export const resolveTheme = (id: string | undefined, prefersLight: boolean) =>
  id === "system" ? (prefersLight ? "light" : "dark") : THEMES.some((t) => t.id === id) ? id! : "dark";
export const isDarkTheme = (id: string) => THEMES.find((t) => t.id === id)?.dark ?? true;
