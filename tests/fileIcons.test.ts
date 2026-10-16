import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileIcon } from "../src/lib/fileIcons";
it("maps names and extensions to sprite symbols that exist", () => {
  expect(fileIcon("App.tsx", false)).toBe("react_ts");
  expect(fileIcon("Cargo.lock", false)).toBe("lock");
  expect(fileIcon("src", true, true)).toBe("folder-open");
  expect(fileIcon("weird.zzz", false)).toBe("document");
  const sprite = readFileSync("public/icons/files.svg", "utf8");
  for (const n of ["a.ts", "a.js", "a.json", "a.md", "a.rs", "a.py", "a.go", "a.html", "a.css", "a.png", "a.toml", "a.sh", "x"]) expect(sprite).toContain(`id="${fileIcon(n, false)}"`);
  for (const o of [true, false]) expect(sprite).toContain(`id="${fileIcon("d", true, o)}"`);
});
