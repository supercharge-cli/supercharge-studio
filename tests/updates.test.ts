import { describe, expect, it } from "vitest";
import { isNewer } from "../src/lib/updates";

describe("release compare", () => {
  it("treats a higher version as newer", () => {
    expect(isNewer("v0.1.7", "0.1.6")).toBe(true);
    expect(isNewer("0.1.7", "0.1.7")).toBe(false);
    expect(isNewer("0.1.5", "0.1.7")).toBe(false);
  });
});