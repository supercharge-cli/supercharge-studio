import { describe, expect, it } from "vitest";
import { extractMentions, fileItems, fileUri, mentionBlocks } from "../src/lib/mentions";

const files = [
  { path: "README.md", dir: false }, { path: "src/", dir: true }, { path: "src/App.tsx", dir: false },
  { path: "src/lib/", dir: true }, { path: "src/lib/store.ts", dir: false }, { path: "my docs/", dir: true }, { path: "my docs/a b.md", dir: false },
];

describe("@ mentions", () => {
  it("finds mentioned files and folders that exist", () => {
    const m = extractMentions('read @README.md, then @src/lib and @"my docs/a b.md" but not @nope or a@b', files);
    expect(m.map((f) => f.path)).toEqual(["README.md", "src/lib/", "my docs/a b.md"]);
  });
  it("ranks file names, supports path queries", () => {
    const all = fileItems(files, "").map((i) => i.value);
    expect(all).toContain("README.md");
    expect(all).toContain("src/");
    expect(all).toContain("src/lib/");
    expect(all).toContain("src/lib/store.ts");
    expect(fileItems(files, "store")[0].value).toBe("src/lib/store.ts");
    expect(fileItems(files, "src/l").map((i) => i.value)).toEqual(["src/lib/", "src/lib/store.ts"]);
    expect(fileItems(files, "app")[0]).toMatchObject({ label: "App.tsx", detail: "src/", icon: "file" });
  });
  it("embeds small text files and links folders", async () => {
    const b = await mentionBlocks("/p", [files[0], files[3]], true, async () => "# hi");
    expect(b).toEqual([
      { type: "resource", resource: { uri: "file:///p/README.md", mimeType: "text/markdown", text: "# hi" } },
      { type: "resource_link", uri: "file:///p/src/lib", name: "lib", mimeType: "inode/directory" },
    ]);
    const l = await mentionBlocks("/p", [files[0]], false, async () => "x");
    expect(l[0]).toMatchObject({ type: "resource_link", name: "README.md" });
    const fail = await mentionBlocks("/p", [files[2]], true, async () => { throw new Error("binary"); });
    expect(fail[0]).toMatchObject({ type: "resource_link" });
    expect(fileUri("C:\\x\\a b.txt")).toBe("file:///C:/x/a%20b.txt");
  });
});
