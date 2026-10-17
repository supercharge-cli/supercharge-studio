import { describe, expect, it } from "vitest";
import { agentModel, sessionModel, setupModel } from "../src/lib/modelFallback";

describe("model picker fallback", () => {
  it("keeps the agent's option, even with no choices but a current model", () => {
    expect(agentModel([{ id: "model", currentValue: "m1", options: [] }])?.options).toEqual([{ value: "m1", name: "m1" }]);
    expect(agentModel([{ id: "reasoning_effort", options: [{ value: "low" }] }])).toBeUndefined();
  });
  it("uses ACP session model state", () => {
    const m = sessionModel({ currentModelId: "a", availableModels: [{ modelId: "a", name: "A" }, { modelId: "b" }] });
    expect(m?.source).toBe("session");
    expect(m?.options).toEqual([{ value: "a", name: "A" }, { value: "b", name: "b" }]);
    expect(sessionModel(undefined)).toBeUndefined();
  });
  it("falls back to the configured provider's models and shows the current one when the list fails", async () => {
    const api: any = { status: async () => ({ providerId: "groq", baseUrl: "u", format: "chat_completions", model: "x" }), models: async () => { throw new Error("offline"); } };
    const m = await setupModel(api);
    expect(m?.currentValue).toBe("x");
    expect(m?.options).toEqual([{ value: "x", name: "x" }]);
  });
});
