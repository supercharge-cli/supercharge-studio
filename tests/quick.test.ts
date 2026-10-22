import { describe, expect, it } from "vitest";
import { answerOption, permKey } from "../src/lib/quick";

describe("phone quick actions", () => {
  it("maps Allow / Deny to the request's options", () => {
    const o = [{ optionId: "a2", kind: "allow_always" }, { optionId: "a1", kind: "allow_once" }, { optionId: "r1", kind: "reject_once" }];
    expect(answerOption(o, true)).toBe("a1");
    expect(answerOption(o, false)).toBe("r1");
    expect(answerOption([{ optionId: "x", kind: "allow_always" }], true)).toBe("x");
    expect(answerOption([{ optionId: "x", kind: "allow_always" }], false)).toBeUndefined();
    expect(permKey({ sessionId: "s", toolCall: { toolCallId: "t" } })).toBe("s:t");
  });
});
