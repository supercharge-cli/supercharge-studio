import { describe, expect, it } from "vitest";
import { diffLines, diffStats, hunks } from "../src/lib/diff";
import { score } from "../src/components/CommandPalette";

describe("diff", () => {
  it("computes line changes", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc\nd");
    expect(d.map((l) => l.t + l.s)).toEqual([" a", "-b", "+B", " c", "+d"]);
    expect(diffStats(d)).toEqual({ add: 2, del: 1 });
    expect(d[3]).toMatchObject({ a: 3, b: 3 });
  });
  it("treats a new file as all additions", () => {
    expect(diffStats(diffLines(null, "x\ny"))).toEqual({ add: 2, del: 0 });
  });
  it("groups hunks with context", () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const neu = old.replace("l2\n", "L2\n").replace("l25\n", "L25\n");
    const hs = hunks(diffLines(old, neu), 2);
    expect(hs).toHaveLength(2);
    expect(hs[0].lines.length).toBe(2 + 2 + 2);
  });
});

describe("palette score", () => {
  it("fuzzy matches subsequences and prefers word starts", () => {
    expect(score("nc", "New chat")).toBeGreaterThan(0);
    expect(score("xyz", "New chat")).toBe(-1);
    expect(score("set", "Open settings")).toBeGreaterThan(score("set", "Reset tabs"));
  });
});
