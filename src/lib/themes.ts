/** Color themes. Each id maps to a `[data-theme="id"]` block in styles.css. */
export type ThemeInfo = { id: string; name: string; dark: boolean };
export const THEMES: ThemeInfo[] = [
  { id: "dark", name: "Dark", dark: true },
  { id: "light", name: "Light", dark: false },
];
export const themeList: (ThemeInfo | { id: "system"; name: string; dark: boolean })[] = [{ id: "system", name: "System", dark: true }, ...THEMES];
