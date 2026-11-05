import { describe, expect, it } from "vitest";
import type { ConfigOption } from "../src/acp/types";
import { setModelRequest } from "../src/lib/sessionOptions";

const model: ConfigOption = { id: "model", currentValue: "fast", options: [{ value: "fast" }, { value: "deep" }] };

function reasoning(currentValue: string | undefined, id = "reasoning_effort"): ConfigOption {
  return { id, category: "thought_level", currentValue, options: [{ value: "off" }, { value: "low" }, { value: "high" }] };
}

describe("session/set_model reasoningEffort", () => {
  it("sends the chat's current reasoning option, mapping off to none", () => {
    expect(setModelRequest("s1", "deep", [model, reasoning("high")], "low")).toEqual({
      method: "session/set_model",
      params: { sessionId: "s1", modelId: "deep", _meta: { reasoningEffort: "high" } },
    });
    expect(setModelRequest("s1", "deep", [model, reasoning("off")], "high").params._meta).toEqual({ reasoningEffort: "none" });
    expect(setModelRequest("s1", "deep", [model, reasoning("medium", "other")], undefined).params._meta).toEqual({ reasoningEffort: "medium" });
  });

  it("falls back to lastEffort and omits _meta when neither exists", () => {
    expect(setModelRequest("s1", "deep", [model], "low").params).toEqual({ sessionId: "s1", modelId: "deep", _meta: { reasoningEffort: "low" } });
    expect(setModelRequest("s1", "deep", [model], "off").params._meta).toEqual({ reasoningEffort: "none" });
    const bare = setModelRequest("s1", "deep", [model], undefined);
    expect(bare.method).toBe("session/set_model");
    expect(bare.params).toEqual({ sessionId: "s1", modelId: "deep" });
    expect("_meta" in bare.params).toBe(false);
    expect("_meta" in setModelRequest("s1", "deep", undefined, "").params).toBe(false);
  });
});
