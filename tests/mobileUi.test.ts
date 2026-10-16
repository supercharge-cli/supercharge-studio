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
