import { describe, expect, it, vi } from "vitest";
import { CUSTOM, CUSTOM_MODEL, FORMATS, PROVIDERS, agentSetup, filterModels, filterProviders, listProviderModels, providerCatalog, keyReusable, normBase, normalizeStatus, pickSetup, pollDevice, providersFromStatus, rpcSetup, switchedLive, unlistedProvider, type SetupApi } from "../src/lib/setup";
import { GatewayHub, type HubHost } from "../src/gateway/hub";

describe("provider setup catalog", () => {
  it("lists the CLI's /setup providers in its order, then Custom", () => {
    expect(filterProviders("").map((p) => p.name)).toEqual([
      "Pollinations", "OpenAI", "Anthropic", "OpenRouter", "DeepSeek", "Google AI Studio", "Groq", "Z.AI / GLM", "Kimi Coding",
      "Moonshot (Kimi Anthropic)", "Qwen Cloud", "Mistral AI", "Together AI", "Fireworks AI", "xAI (Grok)", "Routing.run", "ZenLLM",
      "Nous Research", "Ollama (local)", "LM Studio", "Custom / paste a base URL",
    ]);
    expect(PROVIDERS[0].description).toBe("Recommended — large free/cheap model list");
    expect(PROVIDERS.find((p) => p.id === "nous")).toMatchObject({ device: true, description: "Nous Portal OAuth — free-tier models", baseUrl: "https://inference-api.nousresearch.com/v1" });
    expect(PROVIDERS.filter((p) => p.format === "messages").map((p) => p.id)).toEqual(["anthropic", "kimi"]);
    expect(PROVIDERS.filter((p) => p.keyOptional).map((p) => p.id)).toEqual(["ollama", "lmstudio"]);
    expect(FORMATS.map((f) => f[1])).toEqual(["Chat Completions", "Messages", "Responses"]);
  });
  it("filters by id, name or description like the CLI", () => {
    expect(filterProviders("nous").map((p) => p.id)).toEqual(["nous"]);
    expect(filterProviders("key optional").map((p) => p.id)).toEqual(["ollama", "lmstudio"]);
    expect(filterProviders("openai").at(-1)).toBe(CUSTOM);
    expect(filterProviders("base url")).toEqual([CUSTOM]);
    expect(filterProviders("zzz")).toEqual([]);
  });
  it("adds the custom model row", () => {
    const m = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
    expect(filterModels(m, "").map((x) => x.id)).toEqual(["a", "b", CUSTOM_MODEL]);
    expect(filterModels(m, "alp").map((x) => x.id)).toEqual(["a"]);
    expect(filterModels(m, "type").map((x) => x.id)).toEqual([CUSTOM_MODEL]);
  });
});

describe("the CLI's provider catalog from setup/status", () => {
  const raw = [
    { id: "openrouter", name: "OpenRouter", description: "Aggregator", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "a/b", format: "openai", curated: true, auth: "api_key" },
    { id: "kimi", name: "Kimi", description: "Anthropic-compatible", baseUrl: "https://api.moonshot.ai/anthropic", defaultModel: "k2", format: "anthropic", curated: true, auth: "api_key" },
    { id: "nous", name: "Nous Research", description: "Portal login", baseUrl: "https://inference-api.nousresearch.com/v1", defaultModel: "H", format: "openai", curated: true, auth: "oauth_device" },
    { id: "agentrouter", name: "AgentRouter", description: "Aggregator via AgentRouter", baseUrl: "https://api.agentrouter.org/v1", defaultModel: "gpt-5.6-sol", format: "responses", curated: false, auth: "api_key" },
    { id: "ollama", name: "Ollama", description: "Local", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.3", format: "openai", curated: true, auth: "api_key" },
  ];
  const status = normalizeStatus({ providerId: "agentrouter", baseUrl: "https://api.agentrouter.org/v1", format: "responses", modelId: "gpt-5.6-sol", hasApiKey: true, providers: raw });
  it("uses the CLI's order, names and URLs, maps formats and device login", () => {
    const c = providerCatalog(status);
    expect(c.map((p) => p.id)).toEqual(["openrouter", "kimi", "nous", "agentrouter", "ollama"]);
    expect(c.map((p) => p.format)).toEqual(["chat_completions", "messages", "chat_completions", "responses", "chat_completions"]);
    expect(c.filter((p) => p.device).map((p) => p.id)).toEqual(["nous"]);
    expect(c[0]).toEqual({ id: "openrouter", name: "OpenRouter", description: "Aggregator", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "a/b", format: "chat_completions" });
    expect(c.find((p) => p.id === "ollama")?.keyOptional).toBe(true); // local servers stay key-optional
    expect(filterProviders("", null, c).map((p) => p.id)).toEqual([...raw.map((p) => p.id), CUSTOM.id]);
    expect(filterProviders("agentrouter", null, c).map((p) => p.id)).toEqual(["agentrouter"]);
  });
  it("needs no unlisted row for a provider the CLI catalog has", () => {
    expect(unlistedProvider(status)).toBeNull();
    expect(unlistedProvider(normalizeStatus({ providerId: "mine", baseUrl: "http://h/v1", providers: raw }))).toMatchObject({ id: "mine", name: "Mine", baseUrl: "http://h/v1" });
  });
  it("falls back to the built-in list only when the CLI sends no catalog", () => {
    expect(providerCatalog(normalizeStatus({ providerId: "groq" }))).toBe(PROVIDERS);
    expect(providerCatalog(normalizeStatus({ providers: [] }))).toBe(PROVIDERS);
    expect(providerCatalog(null)).toBe(PROVIDERS);
  });
  it("lists a Studio provider's models through the CLI, never with an app-held key", async () => {
    const models = vi.fn(async () => [{ id: "m", name: "M" }]);
    const api = { models } as unknown as SetupApi;
    const c = providerCatalog(status);
    expect(await listProviderModels(api, { baseUrl: " https://openrouter.ai/api/v1/ ", format: "responses" }, c)).toEqual([{ id: "m", name: "M" }]);
    expect(models).toHaveBeenLastCalledWith("openrouter", "https://openrouter.ai/api/v1/", undefined, "responses");
    await listProviderModels(api, { baseUrl: "https://x.example/v1", format: "messages", cli: "agentrouter|https://x.example/v1" }, c);
    expect(models).toHaveBeenLastCalledWith("agentrouter", "https://x.example/v1", undefined, "messages");
    await listProviderModels(api, { baseUrl: "http://127.0.0.1:9000/v1", format: "chat_completions" }, c);
    expect(models).toHaveBeenLastCalledWith("custom", "http://127.0.0.1:9000/v1", undefined, "chat_completions");
  });
  it("goes over the agent's _supercharge/setup/models", async () => {
    const ext = vi.fn(async (m: string) => (m.endsWith("/models") ? { models: [{ id: "x", name: "X" }], providerId: "groq" } : {}));
    const api = agentSetup({ hasExtension: (m) => m === "_supercharge/setup/save", ext })!;
    expect(await listProviderModels(api, { baseUrl: "https://api.groq.com/openai/v1", format: "chat_completions" })).toEqual([{ id: "x", name: "X" }]);
    expect(ext).toHaveBeenLastCalledWith("_supercharge/setup/models", { providerId: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: undefined, format: "chat_completions" });
    expect(agentSetup({ hasExtension: () => false, ext })).toBeNull();
    expect(agentSetup(null)).toBeNull();
  });
});

describe("unlisted CLI providers", () => {
  const cliProvider = { id: "agentrouter", name: "AgentRouter", description: "Aggregator", baseUrl: "https://api.agentrouter.org/v1", defaultModel: "gpt-5.6-sol", format: "responses" };
  it("does not duplicate a provider the CLI catalog already lists", () => {
    const status = normalizeStatus({ providerId: "agentrouter", baseUrl: "https://api.agentrouter.org/v1", format: "responses", modelId: "gpt-5.6-sol", hasApiKey: true, providers: [cliProvider] });
    expect(unlistedProvider(status)).toBeNull();
  });
  it("falls back to the saved status when the catalog lacks it, and names a bare id", () => {
    const status = normalizeStatus({ providerId: "my_gateway", baseUrl: "http://127.0.0.1:8080/v1", model: "m1" });
    const p = unlistedProvider(status)!;
    expect(p).toMatchObject({ id: "my_gateway", name: "My Gateway", baseUrl: "http://127.0.0.1:8080/v1", defaultModel: "m1", format: "chat_completions" });
  });
  it("returns nothing for listed, custom or absent providers", () => {
    expect(unlistedProvider(normalizeStatus({ providerId: "groq" }))).toBeNull();
    expect(unlistedProvider(normalizeStatus({ providerId: "custom" }))).toBeNull();
    expect(unlistedProvider(normalizeStatus(null))).toBeNull();
    expect(unlistedProvider(null)).toBeNull();
  });
  it("normalizes the raw CLI status fields", () => {
    const s = normalizeStatus({ providerId: "x", modelId: "m", hasApiKey: true, oauth: { nous: { signedIn: true } } });
    expect(s).toMatchObject({ model: "m", hasKey: true, nousSignedIn: true });
    expect(normalizeStatus({ model: "m2", hasKey: true, nousSignedIn: false })).toMatchObject({ model: "m2", hasKey: true, nousSignedIn: false });
  });
  it("shows the extra provider in filtered lists before Custom", () => {
    const extra = unlistedProvider(normalizeStatus({ providerId: "agentrouter", baseUrl: cliProvider.baseUrl, format: "responses" }));
    expect(filterProviders("", extra).map((p) => p.id)).toEqual([...PROVIDERS.map((p) => p.id), "agentrouter", CUSTOM.id]);
    expect(filterProviders("agentrouter", extra).map((p) => p.id)).toEqual(["agentrouter"]);
    expect(filterProviders("agentrouter", null)).toEqual([]);
    expect(filterProviders("custom", extra).map((p) => p.id)).toEqual([CUSTOM.id]);
  });
  it("replaces the built-in list with the CLI catalog", () => {
    const status = normalizeStatus({
      providers: [
        { id: "codex", name: "ChatGPT (Codex)", description: "ChatGPT plan via Codex browser sign-in", baseUrl: "https://chatgpt.com/backend-api/codex", defaultModel: "gpt-6.1-terra", format: "responses", auth: "api_key" },
        { id: "mistral-auth", name: "Mistral Auth", description: "Browser sign-in", baseUrl: "https://api.mistral.ai/v1", defaultModel: "large-model-latest", format: "openai", auth: "api_key" },
        { id: "nous", name: "Nous Research", description: "Nous Portal OAuth", baseUrl: "https://inference-api.nousresearch.com/v1", defaultModel: "Hermes-4.3-36B", format: "openai", auth: "oauth_device" },
        { id: "ollama", name: "Ollama (local)", description: "Local server, key optional", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.3", format: "openai", auth: "api_key" },
      ],
    });
    const catalog = providersFromStatus(status);
    expect(catalog?.map((p) => p.id)).toEqual(["codex", "mistral-auth", "nous", "ollama"]);
    expect(catalog?.find((p) => p.id === "nous")).toMatchObject({ device: true, format: "chat_completions" });
    expect(catalog?.find((p) => p.id === "codex")?.format).toBe("responses");
    expect(catalog?.find((p) => p.id === "ollama")?.keyOptional).toBe(true);
    expect(filterProviders("", null, catalog).map((p) => p.id)).toEqual(["codex", "mistral-auth", "nous", "ollama", CUSTOM.id]);
    expect(unlistedProvider(normalizeStatus({ providerId: "codex", providers: status.providers }))).toBeNull();
  });
});

describe("device-code polling", () => {
  const api = (seq: string[]) => ({ devicePoll: vi.fn(async () => seq.shift() ?? "pending") }) as unknown as SetupApi & { devicePoll: ReturnType<typeof vi.fn> };
  it("waits the interval, slows down when asked, stops when done", async () => {
    const waits: number[] = [];
    const a = api(["pending", "slow_down", "pending", "done"]);
    await pollDevice(a, 2, 900, () => false, async (ms) => { waits.push(ms); });
    expect(waits).toEqual([2000, 2000, 3000, 3000]);
    expect(a.devicePoll).toHaveBeenCalledTimes(4);
  });
  it("stops on cancel and on errors", async () => {
    await expect(pollDevice(api([]), 1, 900, () => true, async () => {})).rejects.toThrow("cancelled");
    const bad = { devicePoll: async () => { throw new Error("Nous login access_denied"); } } as unknown as SetupApi;
    await expect(pollDevice(bad, 1, 900, () => false, async () => {})).rejects.toThrow("access_denied");
  });
});

describe("setup over JSON-RPC", () => {
  it("maps ops and results", async () => {
    const call = vi.fn(async (op: string) => (op === "models" ? { models: [{ id: "m", name: "M" }] } : op === "device_poll" ? { status: "done" } : { hasKey: false }));
    const api = rpcSetup(call);
    expect(await api.models("openai", "https://api.openai.com/v1", "k", "chat_completions")).toEqual([{ id: "m", name: "M" }]);
    expect(call).toHaveBeenLastCalledWith("models", { providerId: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", format: "chat_completions" });
    expect(await api.devicePoll()).toBe("done");
  });
  it("prefers the agent's _supercharge/setup methods when advertised", async () => {
    const ext = vi.fn(async () => ({ hasKey: true }));
    const api = pickSetup({ hasExtension: (m) => m === "_supercharge/setup/save", ext });
    await api!.status();
    expect(ext).toHaveBeenCalledWith("_supercharge/setup/status", {});
    expect(pickSetup({ hasExtension: () => false, ext })).toBeNull(); // no desktop shell in tests
  });
  it("the gateway forwards setup steps to the computer and rejects unknown ones", async () => {
    const sent: any[] = [];
    const setup = vi.fn(async (op: string) => (op === "models" ? [{ id: "x", name: "X" }] : op === "device_poll" ? "pending" : { hasKey: false }));
    const host = { sessions: () => [], projects: () => [], prompt: async () => ({ stopReason: "end_turn" }), cancel() {}, newSession: async () => "s", focus() {}, setup } as unknown as HubHost;
    const hub = new GatewayHub((_d, m) => sent.push(m), host);
    await hub.receive("d", { id: 1, method: "initialize", params: {} });
    expect(sent.at(-1).result.agentCapabilities._meta.supercharge.setup).toBe(true);
    await hub.receive("d", { id: 2, method: "_supercharge/setup", params: { op: "models", providerId: "groq" } });
    expect(sent.at(-1).result).toEqual({ models: [{ id: "x", name: "X" }] });
    expect(setup).toHaveBeenCalledWith("models", { op: "models", providerId: "groq" });
    await hub.receive("d", { id: 3, method: "_supercharge/setup", params: { op: "device_poll" } });
    expect(sent.at(-1).result).toEqual({ status: "pending" });
    await hub.receive("d", { id: 4, method: "_supercharge/setup", params: { op: "rm -rf" } });
    expect(sent.at(-1).error.code).toBe(-32602);
    const bare = new GatewayHub((_d, m) => sent.push(m), { ...host, setup: undefined } as HubHost);
    await bare.receive("d", { id: 5, method: "_supercharge/setup", params: { op: "status" } });
    expect(sent.at(-1).error.code).toBe(-32601);
  });
});

describe("save: key reuse and live session switch", () => {
  it("reuses a saved key only for the same base URL, like the CLI", () => {
    const st = { providerId: "one", baseUrl: "https://api.one.example/v1", hasKey: true, nousSignedIn: false };
    expect(normBase(" api.one.example/v1/models/ ")).toBe("https://api.one.example/v1");
    expect(keyReusable(st, "https://api.one.example/v1/")).toBe(true);
    expect(keyReusable(st, "https://api.two.example/v1")).toBe(false);
    expect(keyReusable({ ...st, hasKey: false }, st.baseUrl)).toBe(false);
    expect(keyReusable(st, "")).toBe(false);
    expect(keyReusable(null, st.baseUrl)).toBe(false);
  });
  it("sends the open chat's sessionId to the agent and reads switchedSessions", async () => {
    const ext = vi.fn(async () => ({ saved: true, modelId: "m", switchedSessions: ["s1"] }));
    const api = pickSetup({ hasExtension: (m) => m === "_supercharge/setup/save", ext })!;
    const r = await api.save({ providerId: "two", baseUrl: "https://api.two.example/v1", format: "chat_completions", modelId: "m", sessionId: "s1" });
    expect(ext).toHaveBeenLastCalledWith("_supercharge/setup/save", { providerId: "two", baseUrl: "https://api.two.example/v1", format: "chat_completions", modelId: "m", sessionId: "s1" });
    expect(switchedLive(r)).toBe(true);
    await api.save({ providerId: "two", baseUrl: "https://api.two.example/v1", format: "chat_completions", modelId: "m" });
    expect(ext.mock.calls.at(-1)).toEqual(["_supercharge/setup/save", { providerId: "two", baseUrl: "https://api.two.example/v1", format: "chat_completions", modelId: "m" }]);
    expect(switchedLive({ hasKey: true })).toBe(false);
    expect(switchedLive(undefined)).toBe(false);
  });
});
