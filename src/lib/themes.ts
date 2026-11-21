/** Color themes. Each id maps to a `[data-theme="id"]` block in styles.css. */
export type ThemeInfo = { id: string; name: string; dark: boolean; swatch: [string, string, string] };

/** Older theme ids from an earlier redesign; map them so saved settings keep working. */
export const THEME_ALIASES: Record<string, string> = {
  zed: "graphite",
  warp: "carbon",
  tokyo: "twilight",
  gruvbox: "retro",
  nord: "arctic",
};

export const canonicalThemeId = (id: string | undefined) => (id && THEME_ALIASES[id]) || id;

export const THEMES: ThemeInfo[] = [
  { id: "dark", name: "Dark", dark: true, swatch: ["#0a0b0e", "#0f1218", "#8b7cff"] },
  { id: "graphite", name: "Graphite", dark: true, swatch: ["#131418", "#1e2029", "#38bdf8"] },
  { id: "carbon", name: "Carbon", dark: true, swatch: ["#090a0f", "#181b26", "#00e5a3"] },
  { id: "ascii", name: "ASCII Mono", dark: true, swatch: ["#050505", "#161616", "#f5f5f5"] },
  { id: "matrix", name: "Matrix Green", dark: true, swatch: ["#040804", "#101c10", "#00ff66"] },
  { id: "amber", name: "Amber Phosphor", dark: true, swatch: ["#0d0a04", "#221a0d", "#ffb000"] },
  { id: "arctic", name: "Arctic", dark: true, swatch: ["#242933", "#3b4252", "#88c0d0"] },
  { id: "twilight", name: "Twilight", dark: true, swatch: ["#1a1b26", "#24283b", "#7dcfff"] },
  { id: "retro", name: "Retro", dark: true, swatch: ["#1d2021", "#32302f", "#fe8019"] },
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

export const findTheme = (q: string) => {
  const key = q.trim().toLowerCase();
  const id = canonicalThemeId(key) ?? key;
  return themeList.find((x) => x.id === id || x.id === key || x.name.toLowerCase() === key);
};

/** Resolve a saved theme id to a concrete one (unknown ids fall back to dark). */
export const resolveTheme = (id: string | undefined, prefersLight: boolean) => {
  const t = canonicalThemeId(id);
  return t === "system" ? (prefersLight ? "light" : "dark") : THEMES.some((x) => x.id === t) ? t! : "dark";
};
export const isDarkTheme = (id: string) => THEMES.find((t) => t.id === canonicalThemeId(id))?.dark ?? true;
