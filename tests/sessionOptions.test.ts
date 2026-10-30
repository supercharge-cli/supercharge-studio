import { describe, expect, it } from "vitest";
import { effortLabel, effortToApply, normalizeEffort, optionFor, reasoningOption, sameEffort, shownModel, updateSessionOptions } from "../src/lib/sessionOptions";

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
  it("reapplies the last thinking level only when the model offers it (CLI reasoning_effort shape)", () => {
    const cli = [{ id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select", currentValue: "medium", options: ["minimal", "low", "medium", "high", "xhigh"].map((value) => ({ value, name: value === "xhigh" ? "X-High" : value })) }];
    expect(effortToApply(cli, "high")).toBe("high");
    expect(effortToApply(cli, "medium")).toBeUndefined();
    expect(effortToApply(cli, undefined)).toBeUndefined();
    expect(effortToApply(cli, "max")).toBeUndefined();
    expect(effortToApply(first, "high")).toBeUndefined();
    expect(effortToApply([{ id: "reasoning_effort", currentValue: "low", options: [{ value: "none" }, { value: "low" }] }], "off")).toBe("none");
    expect(effortLabel("minimal")).toBe("Minimal");
  });
  it("shows the session's real model before the last pick", () => {
    const agent = { id: "model", currentValue: "studio-test-1", options: [{ value: "studio-test-1" }, { value: "grok-4.6" }] };
    expect(shownModel(agent, "grok-4.6", undefined)).toBe("studio-test-1");
    expect(shownModel(agent, undefined, undefined)).toBe("studio-test-1");
    expect(shownModel(agent, "vendor/typed", undefined)).toBe("vendor/typed");
    expect(shownModel(undefined, "grok-4.6", "x")).toBe("grok-4.6");
    expect(shownModel(undefined, undefined, "x")).toBe("x");
  });
});
