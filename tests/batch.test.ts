import { describe, expect, it } from "vitest";
import { parsePrice } from "../src/lib/usage";
import { clampSidebar, recentChats } from "../src/lib/store";

describe("parsePrice", () => {
  it("accepts decimals", () => {
    expect(parsePrice("0.1")).toBe(0.1);
    expect(parsePrice(".5")).toBe(0.5);
    expect(parsePrice("2.75")).toBe(2.75);
    expect(parsePrice("3.")).toBe(3);
    expect(parsePrice("1,5")).toBe(1.5);
  });
  it("rejects junk", () => {
    for (const v of ["", ".", "-1", "abc", "1.2.3"]) expect(parsePrice(v)).toBeNull();
  });
});

describe("recentChats", () => {
  it("flattens and sorts newest first", () => {
    const d: any = { groups: [{ id: "g", name: "G", projects: [
      { id: "a", name: "A", cwd: "/a", chats: [{ id: "1", title: "one", createdAt: 1, updatedAt: 5 }, { id: "2", title: "two", createdAt: 2 }] },
      { id: "b", name: "", cwd: "/x/bee", chats: [{ id: "3", title: "three", createdAt: 9 }] },
    ] }] };
    const r = recentChats(d);
    expect(r.map((x) => x.chat.id)).toEqual(["3", "1", "2"]);
    expect(r[0].projectName).toBe("bee");
  });
});

describe("clampSidebar", () => {
  it("clamps", () => { expect(clampSidebar(10)).toBe(180); expect(clampSidebar(900)).toBe(480); expect(clampSidebar(300.4)).toBe(300); });
});
