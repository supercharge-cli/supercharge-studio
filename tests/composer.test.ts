import { describe, expect, it } from "vitest";
import { filterItems, insertMention, menuState, parseSlash } from "../src/lib/composer";

describe("composer menu", () => {
  it("opens the right menu for the text before the caret", () => {
    expect(menuState("/", 1)).toEqual({ kind: "slash", q: "" });
    expect(menuState("/mod", 4)).toEqual({ kind: "slash", q: "mod" });
    expect(menuState("/models ", 8)).toBeNull();
    expect(menuState("/models gp", 10, (c) => c === "models")).toEqual({ kind: "sub", cmd: "models", q: "gp" });
    expect(menuState("hi /x", 5)).toBeNull();
    expect(menuState("look at @src/Ap", 15)).toEqual({ kind: "mention", q: "src/Ap", start: 8, end: 15 });
    expect(menuState("@", 1)).toEqual({ kind: "mention", q: "", start: 0, end: 1 });
    expect(menuState("mail me@host", 12)).toBeNull();
  });
  it("ranks prefix matches first, then fuzzy", () => {
    const items = ["help", "theme", "models", "new", "setup", "usage"].map((l) => ({ id: l, label: l, value: l }));
    expect(filterItems(items, "m")[0].label).toBe("models");
    expect(filterItems(items, "th").map((x) => x.label)).toEqual(["theme"]);
    expect(filterItems(items, "sup").map((x) => x.label)).toContain("setup");
    expect(filterItems(items, "zzz")).toEqual([]);
    expect(filterItems(items, "").length).toBe(6);
  });
  it("parses commands and inserts mentions", () => {
    expect(parseSlash("/Theme  light ")).toEqual({ name: "theme", args: "light" });
    expect(parseSlash("hello")).toBeNull();
    expect(insertMention("see @sr now", 4, 7, "src/App.tsx")).toEqual({ draft: "see @src/App.tsx now", caret: 17 });
    expect(insertMention("@", 0, 1, "my dir/")).toEqual({ draft: '@"my dir/" ', caret: 11 });
  });
});
