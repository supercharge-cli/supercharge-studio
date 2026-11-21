/** Theme ids and names. Swatches live in themes.ts, loaded with Appearance. */
export type ThemeId = { id: string; name: string; dark: boolean };

import { THEME_ALIASES, canonicalThemeId } from "./themeAliases";
export { THEME_ALIASES, canonicalThemeId };

export const THEME_IDS: ThemeId[] = [
  { id: "dark", name: "Dark", dark: true },
  { id: "graphite", name: "Graphite", dark: true },
  { id: "carbon", name: "Carbon", dark: true },
  { id: "ascii", name: "ASCII Mono", dark: true },
  { id: "matrix", name: "Matrix Green", dark: true },
  { id: "amber", name: "Amber Phosphor", dark: true },
  { id: "arctic", name: "Arctic", dark: true },
  { id: "twilight", name: "Twilight", dark: true },
  { id: "retro", name: "Retro", dark: true },
  { id: "midnight", name: "Midnight", dark: true },
  { id: "forest", name: "Forest", dark: true },
  { id: "ember", name: "Ember", dark: true },
  { id: "contrast", name: "High contrast", dark: true },
  { id: "light", name: "Light", dark: false },
  { id: "paper", name: "Paper", dark: false },
  { id: "sky", name: "Sky", dark: false },
  { id: "rose", name: "Rose", dark: false },
];
export const SYSTEM_THEME: ThemeId = { id: "system", name: "System", dark: true };
export const themeChoices: ThemeId[] = [SYSTEM_THEME, ...THEME_IDS];

export const findTheme = (q: string) => {
  const key = q.trim().toLowerCase();
  const id = canonicalThemeId(key) ?? key;
  return themeChoices.find((x) => x.id === id || x.id === key || x.name.toLowerCase() === key);
};

export const resolveTheme = (id: string | undefined, prefersLight: boolean) => {
  const t = canonicalThemeId(id);
  return t === "system" ? (prefersLight ? "light" : "dark") : THEME_IDS.some((x) => x.id === t) ? t! : "dark";
};
export const isDarkTheme = (id: string) => THEME_IDS.find((t) => t.id === canonicalThemeId(id))?.dark ?? true;
