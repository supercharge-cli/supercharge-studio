import { describe, expect, it } from "vitest";
import { canonicalThemeId, findTheme, isDarkTheme, resolveTheme, THEMES } from "../src/lib/themes";
import { migrate } from "../src/lib/store";

describe("theme ids", () => {
  it("renames older saved ids and leaves current ids alone", () => {
    expect(canonicalThemeId("zed")).toBe("graphite");
    expect(canonicalThemeId("warp")).toBe("carbon");
    expect(canonicalThemeId("tokyo")).toBe("twilight");
    expect(canonicalThemeId("gruvbox")).toBe("retro");
    expect(canonicalThemeId("nord")).toBe("arctic");
    expect(canonicalThemeId("dark")).toBe("dark");
    expect(canonicalThemeId("midnight")).toBe("midnight");
    expect(canonicalThemeId(undefined)).toBeUndefined();
  });

  it("resolves system and unknown ids, including remapped ones", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("zed", false)).toBe("graphite");
    expect(resolveTheme("graphite", false)).toBe("graphite");
    expect(resolveTheme("nope", false)).toBe("dark");
    expect(isDarkTheme("tokyo")).toBe(true);
    expect(isDarkTheme("light")).toBe(false);
  });

  it("finds a theme by new id, old id, or name", () => {
    expect(findTheme("Graphite")?.id).toBe("graphite");
    expect(findTheme("zed")?.id).toBe("graphite");
    expect(findTheme("Twilight")?.id).toBe("twilight");
    expect(findTheme("  carbon  ")?.id).toBe("carbon");
    expect(findTheme("missing")).toBeUndefined();
  });

  it("lists the remapped themes and keeps Midnight as its own theme", () => {
    const ids = THEMES.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["graphite", "carbon", "twilight", "retro", "arctic", "amber", "midnight"]));
    expect(ids.filter((id) => id === "midnight")).toHaveLength(1);
    expect(ids).not.toEqual(expect.arrayContaining(["zed", "warp", "tokyo", "gruvbox", "nord"]));
  });

  it("migrates a saved theme id on load", () => {
    const d = migrate({ settings: { theme: "zed" } } as any);
    expect(d.settings.theme).toBe("graphite");
    expect(migrate(d)).toBe(d);
  });
});
