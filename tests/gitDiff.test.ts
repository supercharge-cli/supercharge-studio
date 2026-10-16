import { describe, expect, it } from "vitest";
import { editedPaths, heuristicMessage, highlight, hunkPatch, parseUnifiedDiff, sideBySide } from "../src/lib/gitDiff";

const D = `diff --git a/a.txt b/a.txt
index 1..2 100644
--- a/a.txt
+++ b/a.txt
@@ -1,4 +1,4 @@
-1
+1x
 2
 3
 4
@@ -9,4 +9,4 @@
 9
 10
 11
-12
+12y
\\ No newline at end of file
`;

describe("gitDiff", () => {
  it("parses files and hunks with line numbers", () => {
    const [f] = parseUnifiedDiff(D);
    expect(f.oldPath).toBe("a.txt");
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[0].lines[1]).toEqual({ t: "+", s: "1x", b: 1 });
    expect(f.hunks[1].lines[3]).toMatchObject({ t: "-", s: "12", a: 12 });
  });
  it("builds a single-hunk patch keeping the header", () => {
    const [f] = parseUnifiedDiff(D);
    const p = hunkPatch(f, 1);
    expect(p.startsWith("diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -9,4")).toBe(true);
    expect(p).not.toContain("+1x");
    expect(p).toContain("\\ No newline at end of file\n");
  });
  it("pairs side-by-side rows", () => {
    const rows = sideBySide(parseUnifiedDiff(D)[0].hunks[0]);
    expect(rows[0].l?.s).toBe("1");
    expect(rows[0].r?.s).toBe("1x");
    expect(rows).toHaveLength(4);
  });
  it("new file from /dev/null", () => {
    const [f] = parseUnifiedDiff("diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hi\n");
    expect(f.oldPath).toBe("/dev/null");
    expect(f.newPath).toBe("x");
  });
  it("heuristic commit message", () => {
    expect(heuristicMessage([{ path: "src/a.ts", x: " ", y: "M" }])).toBe("Update a.ts");
    expect(heuristicMessage([{ path: "a", x: " ", y: "M" }, { path: "b", x: " ", y: "?" }])).toContain("- Add b");
  });
  it("highlights keywords and strings", () => {
    expect(highlight('const x = "a"')).toEqual([["const", "hl-k"], [" x = "], ['"a"', "hl-s"]]);
  });
  it("collects edited paths from tool calls", () => {
    expect(editedPaths([{ content: [{ type: "diff", path: "/p/a" }, { type: "diff", path: "/p/a" }] }, { content: [{ type: "content" }] }])).toEqual(["/p/a"]);
  });
});
