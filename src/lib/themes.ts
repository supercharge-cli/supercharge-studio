/** Color themes. Each id maps to a `[data-theme="id"]` block in styles.css. */
export type ThemeInfo = { id: string; name: string; dark: boolean; swatch: [string, string, string] };
export const THEMES: ThemeInfo[] = [
  { id: "dark", name: "Dark", dark: true, swatch: ["#0a0b0e", "#0f1218", "#8b7cff"] },
  { id: "zed", name: "Zed Dark", dark: true, swatch: ["#131418", "#1e2029", "#38bdf8"] },
  { id: "warp", name: "Warp Carbon", dark: true, swatch: ["#090a0f", "#181b26", "#00e5a3"] },
  { id: "ascii", name: "ASCII Mono", dark: true, swatch: ["#050505", "#161616", "#f5f5f5"] },
  { id: "matrix", name: "Matrix Green", dark: true, swatch: ["#040804", "#101c10", "#00ff66"] },
  { id: "amber", name: "Amber Phosphor", dark: true, swatch: ["#0d0a04", "#221a0d", "#ffb000"] },
  { id: "nord", name: "Nord", dark: true, swatch: ["#242933", "#3b4252", "#88c0d0"] },
  { id: "tokyo", name: "Tokyo Night", dark: true, swatch: ["#1a1b26", "#24283b", "#7dcfff"] },
  { id: "gruvbox", name: "Gruvbox", dark: true, swatch: ["#1d2021", "#32302f", "#fe8019"] },
  { id: "midnight", name: "Midnight", dark: true, swatch: ["#0a0f1c", "#111a2e", "#4c8dff"] },
  { id: "forest", name: "Forest", dark: true, swatch: ["#0c1210", "#121b17", "#3ccf8e"] },
  { id: "ember", name: "Ember", dark: true, swatch: ["#140f0d", "#1d1613", "#ff7a45"] },
  { id: "contrast", name: "High contrast", dark: true, swatch: ["#000000", "#0b0b0b", "#1f7cff"] },
  { id: "light", name: "Light", dark: false, swatch: ["#fafbfc", "#eef0f4", "#6a48f5"] },
  { id: "paper", name: "Paper", dark: false, swatch: ["#fbf8f1", "#f2ede1", "#b4572e"] },
  { id: "sky", name: "Sky", dark: false, swatch: ["#f6f9fe", "#eaf1fb", "#1e6ef0"] },
  { id: "rose", name: "Rose", dark: false, swatch: ["#fdf7f8", "#f8ebee", "#d6336c"] },
];
export const SYSTEM_THEME = { id: "system", name: "System", dark: true, swatch: ["#0a0b0e", "#ffffff", "#8b7cff"] as [string, string, string] };
export const themeList: ThemeInfo[] = [SYSTEM_THEME, ...THEMES];
/** Resolve a saved theme id to a concrete one (unknown ids fall back to dark). */
export const resolveTheme = (id: string | undefined, prefersLight: boolean) =>
  id === "system" ? (prefersLight ? "light" : "dark") : THEMES.some((t) => t.id === id) ? id! : "dark";
export const isDarkTheme = (id: string) => THEMES.find((t) => t.id === id)?.dark ?? true;
