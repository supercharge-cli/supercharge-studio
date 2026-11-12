import { describe, expect, it, vi } from "vitest";

const { http } = vi.hoisted(() => ({ http: vi.fn(async (_id: string, _base: string) => [{ id: "from-http" }]) }));
vi.mock("../src/lib/desktop", async (orig) => ({ ...(await orig<typeof import("../src/lib/desktop")>()), providerDiscoverModels: http }));

import { discoverModels } from "../src/components/Settings";
import type { SetupApi } from "../src/lib/setup";

describe("Settings model discovery", () => {
  const p = { id: "p1", name: "Mine", baseUrl: "https://openrouter.ai/api/v1", format: "chat_completions" as const, models: [] };
  it("lists through the CLI's setup API when the agent offers it, not by HTTP from the app", async () => {
    const api = { status: vi.fn(async () => ({ hasKey: true, nousSignedIn: false, providers: [{ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", format: "openai" }] })), models: vi.fn(async () => [{ id: "m", name: "M" }]) } as unknown as SetupApi;
    expect(await discoverModels(p, api)).toEqual([{ id: "m", name: "M" }]);
    expect(api.models).toHaveBeenCalledWith("openrouter", "https://openrouter.ai/api/v1", undefined, "chat_completions");
    expect(http).not.toHaveBeenCalled();
  });
  it("uses the desktop check only when no agent setup is available", async () => {
    expect(await discoverModels(p, null)).toEqual([{ id: "from-http" }]);
    expect(http).toHaveBeenCalledWith("p1", "https://openrouter.ai/api/v1");
  });
});
