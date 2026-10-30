import { describe, expect, it } from "vitest";
import { thoughtLabel } from "../src/components/Thought";

describe("thoughtLabel", () => {
  it("says Thinking while live", () => expect(thoughtLabel(true, 5)).toBe("Thinking…"));
  it("reports how long it took, at least one second", () => {
    expect(thoughtLabel(false, 12)).toBe("Thought for 12s");
    expect(thoughtLabel(false, 0)).toBe("Thought for 1s");
  });
  it("falls back to a plain label for replayed history", () => expect(thoughtLabel(false, undefined)).toBe("Thought"));
});
