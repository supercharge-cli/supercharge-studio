/** Color themes. Each id maps to a `[data-theme="id"]` block in styles.css. */
import { SYSTEM_THEME, THEME_IDS, type ThemeId } from "./themeIds";
export type ThemeInfo = ThemeId & { swatch: [string, string, string] };
export {
  SYSTEM_THEME, THEME_ALIASES, THEME_IDS, canonicalThemeId, findTheme, isDarkTheme, resolveTheme, themeChoices,
} from "./themeIds";

const SW: Record<string, [string, string, string]> = {
  dark: ["#0a0b0e", "#0f1218", "#8b7cff"],
  graphite: ["#131418", "#1e2029", "#38bdf8"],
  carbon: ["#090a0f", "#181b26", "#00e5a3"],
  ascii: ["#050505", "#161616", "#f5f5f5"],
  matrix: ["#040804", "#101c10", "#00ff66"],
  amber: ["#0d0a04", "#221a0d", "#ffb000"],
  arctic: ["#242933", "#3b4252", "#88c0d0"],
  twilight: ["#1a1b26", "#24283b", "#7dcfff"],
  retro: ["#1d2021", "#32302f", "#fe8019"],
  midnight: ["#0a0f1c", "#111a2e", "#4c8dff"],
  forest: ["#0c1210", "#121b17", "#3ccf8e"],
  ember: ["#140f0d", "#1d1613", "#ff7a45"],
  contrast: ["#000000", "#0b0b0b", "#1f7cff"],
  light: ["#fafbfc", "#eef0f4", "#6a48f5"],
  paper: ["#fbf8f1", "#f2ede1", "#b4572e"],
  sky: ["#f6f9fe", "#eaf1fb", "#1e6ef0"],
  rose: ["#fdf7f8", "#f8ebee", "#d6336c"],
  system: ["#0a0b0e", "#ffffff", "#8b7cff"],
};
export const THEMES: ThemeInfo[] = THEME_IDS.map((t) => ({ ...t, swatch: SW[t.id] }));
export const themeList: ThemeInfo[] = [{ ...SYSTEM_THEME, swatch: SW.system }, ...THEMES];
