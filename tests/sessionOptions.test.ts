import { describe, expect, it } from "vitest";
import { optionFor, updateSessionOptions } from "../src/lib/sessionOptions";

const first = [{ id: "model", name: "Model", currentValue: "studio-p-1", options: [{ value: "studio-p-1", name: "First" }, { value: "studio-p-2", name: "Second" }] }];
const second = [{ id: "model", name: "Model", currentValue: "studio-p-2", options: [{ value: "studio-p-1", name: "First" }, { value: "studio-p-2", name: "Second" }] }, { id: "reasoning_effort", currentValue: "low", options: [{ value: "low" }, { value: "high" }] }];

describe("session configuration", () => {
  it("keeps each chat's model and reasoning choices separate", () => {
    const a = updateSessionOptions({}, "chat-a", first);
    const b = updateSessionOptions(a, "chat-b", second);
    expect(optionFor(b["chat-a"], "model")?.currentValue).toBe("studio-p-1");
    expect(optionFor(b["chat-a"], "reasoning_effort")).toBeUndefined();
    expect(optionFor(b["chat-b"], "model")?.currentValue).toBe("studio-p-2");
    expect(optionFor(b["chat-b"], "reasoning_effort")?.currentValue).toBe("low");
  });
  it("does not show unsupported option values", () => {
    expect(optionFor([{ id: "reasoning_effort", currentValue: "high", options: [] }], "reasoning_effort")).toBeUndefined();
    expect(optionFor(first, "reasoning_effort")).toBeUndefined();
  });
});
