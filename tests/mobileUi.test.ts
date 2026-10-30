import { describe, expect, it } from "vitest";
import { connLabel, isNearBottom } from "../src/mobile/MobileApp";

describe("mobile chat helpers", () => {
  it("follows the stream only near the bottom", () => {
    expect(isNearBottom(1000, 400, 560)).toBe(true);
    expect(isNearBottom(1000, 100, 560)).toBe(false);
  });
  it("labels connection states", () => {
    expect(connLabel("reconnecting")).toMatch(/reconnecting/);
    expect(connLabel("closed")).toBe("Offline");
  });
});

import { follows } from "../src/lib/follow";
describe("follows", () => {
  it("re-attaches near the end", () => expect(follows(false, 500, 400, true)).toBe(true));
  it("stays attached while content grows or is re-pinned downwards", () => {
    expect(follows(true, 400, 400, false)).toBe(true);
    expect(follows(true, 400, 900, false)).toBe(true);
  });
  it("detaches only when the reader scrolls up away from the end", () => {
    expect(follows(true, 900, 300, false)).toBe(false);
    expect(follows(false, 300, 600, false)).toBe(false);
  });
});
