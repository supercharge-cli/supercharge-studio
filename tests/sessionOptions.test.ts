import { describe, expect, it } from "vitest";
import { effortLabel, normalizeEffort, optionFor, reasoningOption, sameEffort, updateSessionOptions } from "../src/lib/sessionOptions";

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
  it("labels xhigh as Extra High and treats none as off", () => {
    expect(effortLabel("xhigh")).toBe("Extra High");
    expect(effortLabel("xhigh", "Max")).toBe("Max");
    expect(normalizeEffort("none")).toBe("off");
    expect(effortLabel("none")).toBe("Off");
    expect(sameEffort("none", "off")).toBe(true);
    expect(sameEffort("low", "high")).toBe(false);
  });
  it("finds reasoning by id or thought_level category without rewriting wire values", () => {
    const byCat = reasoningOption([{ id: "other", category: "thought_level", currentValue: "none", options: [{ value: "none" }, { value: "low" }, { value: "xhigh" }] }]);
    expect(byCat?.id).toBe("other");
    expect(byCat?.currentValue).toBe("none");
    expect(byCat?.options?.map((o) => o.value)).toEqual(["none", "low", "xhigh"]);
    expect(byCat?.options?.map((o) => o.name)).toEqual(["Off", "Low", "Extra High"]);
    const byId = reasoningOption([{ id: "reasoning_effort", category: "thought_level", currentValue: "high", options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }] }]);
    expect(byId?.currentValue).toBe("high");
    expect(reasoningOption(first)).toBeUndefined();
  });
});
