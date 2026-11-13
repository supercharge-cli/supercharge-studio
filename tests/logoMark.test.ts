import { describe, expect, it } from "vitest";
import { frame, pad } from "../src/components/LogoMark";

describe("LogoMark", () => {
  it("draws every frame without throwing, across the whole glint cycle", () => {
    const first = frame(0);
    expect(first.length).toBeGreaterThan(20);
    for (let t = -1; t <= 20; t += 0.1) {
      const rows = frame(t);
      expect(rows.length).toBe(first.length);
      for (const row of rows) {
        expect(row.length).toBe(first[0].length);
        for (const c of row) expect(typeof c.ch === "string" && c.ch.length === 1 && typeof c.color === "string").toBe(true);
      }
    }
  });

  it("has no blank trailing row and draws the art (not only spaces)", () => {
    const rows = frame(0);
    expect(rows.at(-1)!.some((c) => c.ch !== " ")).toBe(true);
    expect(rows.flat().filter((c) => c.ch !== " ").length).toBeGreaterThan(100);
    expect(rows.flat().every((c) => c.ch === " " || c.color !== "transparent")).toBe(true);
  });

  it("pads lines and drops trailing blank lines", () => {
    expect(pad("ab\n c\n\n")).toEqual(["ab".padEnd(63), " c".padEnd(63)]);
  });
});
