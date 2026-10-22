import { describe, expect, it } from "vitest";
import { readShareLink, shareLink, SHARE_PREFIX, toJson, toMarkdown } from "../src/lib/exportChat";

const items: any[] = [{ kind: "user", text: "Add a test" }, { kind: "tool", toolCallId: "t1" }, { kind: "agent", text: "Done ✅" }];
describe("chat export", () => {
  it("exports markdown and json", () => {
    expect(toMarkdown("Fix", items)).toBe("# Fix\n\n**You:** Add a test\n\n**Agent:** Done ✅\n");
    expect(JSON.parse(toJson({ title: "Fix", items }))).toMatchObject({ v: 1, title: "Fix", items });
  });
  it("round-trips a share link without tool payloads", async () => {
    const link = await shareLink("Fix", items, "api");
    expect(link.startsWith(SHARE_PREFIX)).toBe(true);
    expect(link.slice(SHARE_PREFIX.length)).not.toMatch(/[+/=]/);
    expect(await readShareLink(link)).toEqual({ v: 1, title: "Fix", project: "api", items: [items[0], items[2]] });
    expect(await readShareLink(SHARE_PREFIX + "garbage")).toBeNull();
    expect(await readShareLink("hello")).toBeNull();
  });
});
