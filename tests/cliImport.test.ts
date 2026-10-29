import { describe, expect, it, vi } from "vitest";
import { applyCli, mergeCli, readCli, type SetupApi } from "../src/lib/setup";
import type { Provider } from "../src/lib/store";

const api = (status: any, models: any[] = [{ id: "m1", name: "M1" }]) => {
  const save = vi.fn(async (_: any) => ({ ok: true }));
  return { save, a: { status: async () => status, models: vi.fn(async () => models), save } as unknown as SetupApi };
};
const cliStatus = { configured: true, providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1/", format: "openai", hasApiKey: true, modelId: "m0", apiKey: "sk-secret", configPath: "~/.supercharge/config.toml" };

describe("CLI provider import", () => {
  it("imports references only (CLI shape: modelId / hasApiKey), never a key", async () => {
    const { a } = api(cliStatus);
    const p = await readCli(a, async () => ({ currentModelId: "m0", models: [{ id: "m0" }, { id: "m2" }] }));
    expect(p).toMatchObject({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1/", format: "chat_completions", models: ["m0", "m2"], cli: "openrouter|https://openrouter.ai/api/v1" });
    expect(JSON.stringify(p)).not.toMatch(/sk-secret|apiKey|config\.toml/);
  });

  it("falls back to setup/models and accepts Studio's status shape", async () => {
    const { a } = api({ providerId: "custom", baseUrl: "http://localhost:8080/v1", format: "anthropic", model: "local", hasKey: false });
    const p = await readCli(a);
    expect(p).toMatchObject({ name: "localhost:8080", format: "messages", models: ["local", "m1"], cli: "custom|http://localhost:8080/v1" });
  });

  it("skips unconfigured or old CLIs", async () => {
    expect(await readCli(api({ configured: false, providerId: "openrouter" }).a)).toBeNull();
    expect(await readCli({ status: async () => { throw new Error("Method not found"); } } as unknown as SetupApi)).toBeNull();
  });

  it("is idempotent and respects edits, removals and hand-made duplicates", async () => {
    const imp = (await readCli(api(cliStatus).a))!;
    const once = mergeCli([], imp)!;
    expect(once).toHaveLength(1);
    expect(mergeCli(once, imp)).toBeNull();
    expect(mergeCli(once, { ...imp, models: ["m9"] })![0]).toMatchObject({ id: imp.id, models: ["m9"] });
    expect(mergeCli([{ ...once[0], name: "Mine", edited: true }], { ...imp, models: ["m9"] })).toBeNull();
    expect(mergeCli([], imp, [imp.cli!])).toBeNull();
    const hand: Provider = { id: "p1", name: "OR", baseUrl: "https://openrouter.ai/api/v1", format: "chat_completions", models: [] };
    expect(mergeCli([hand], imp)).toBeNull();
  });

  it("switches the CLI without sending a key or touching allowed_models", async () => {
    const { a, save } = api(cliStatus);
    const p = (await readCli(a))!;
    await applyCli(a, p, "s1");
    const arg = save.mock.calls[0][0];
    expect(arg).toEqual({ providerId: "openrouter", baseUrl: p.baseUrl, format: "chat_completions", modelId: "m0", sessionId: "s1" });
    expect(Object.keys(arg)).not.toContain("apiKey");
  });
});
