/** Older theme ids from an earlier redesign; map them so saved settings keep working. */
export const THEME_ALIASES: Record<string, string> = {
  zed: "graphite",
  warp: "carbon",
  tokyo: "twilight",
  gruvbox: "retro",
  nord: "arctic",
};

export const canonicalThemeId = (id: string | undefined) => (id && THEME_ALIASES[id]) || id;
