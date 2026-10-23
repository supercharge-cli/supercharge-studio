import { describe, expect, it, vi } from "vitest";
import { agentModel, mergeCustom, rememberCustom, sessionModel } from "../src/lib/modelFallback";
import { saveCustomModel, setupModel } from "../src/lib/modelSave";

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
  it("merges and remembers typed custom models", () => {
    expect(mergeCustom([{ value: "a", name: "A" }], [{ id: "mine", name: "Mine" }, { id: "a" }], "mine")).toEqual([
      { value: "a", name: "A" },
      { value: "mine", name: "Mine" },
    ]);
    expect(rememberCustom([{ id: "old" }], "new", "New")).toEqual([{ id: "new", name: "New" }, { id: "old" }]);
    expect(rememberCustom([{ id: "x", name: "X" }], "x")).toEqual([{ id: "x" }]);
  });
  it("saves a free-text model id through setup/save (not session/set_model)", async () => {
    const save = vi.fn(async (r: any) => r);
    const api: any = {
      status: async () => ({ providerId: "groq", baseUrl: "https://api.groq.com/openai/v1", format: "chat_completions", model: "old", hasKey: true }),
      save,
    };
    await saveCustomModel(api, "vendor/my-model", { modelName: "Mine", sessionId: "s1" });
    expect(save).toHaveBeenCalledWith({
      providerId: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      format: "chat_completions",
      modelId: "vendor/my-model",
      modelName: "Mine",
      sessionId: "s1",
    });
  });
  it("defaults provider to custom when nothing is configured yet", async () => {
    const save = vi.fn(async (r: any) => r);
    const api: any = { status: async () => ({ hasKey: false }), save };
    await saveCustomModel(api, "local-model", { baseUrl: "http://127.0.0.1:11434/v1", format: "chat_completions" });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ providerId: "custom", baseUrl: "http://127.0.0.1:11434/v1", modelId: "local-model" }));
  });
});
