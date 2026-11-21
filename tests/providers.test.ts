import { describe, expect, it } from "vitest";
import { agentProviders, cliProviders, errText, formatChoices, isMissingMethod, isSetUp, keyOptional, removable, signInFlow, signInKinds, takesKey, toModels, untilReady } from "../src/lib/providers";
import { AcpRpcError, discoverExtensions } from "../src/acp/client";
import { fakeSetup } from "../scripts/fakeSetup";

const BROWSER = { id: "mistral-auth", name: "Browser sign-in", description: "", baseUrl: "https://api.example.test/v1", defaultModel: "m-default", format: "openai", curated: [], auth: "api_key", authMethods: ["browser"] };
const ROUTER = { id: "router", name: "Router", description: "", baseUrl: "https://router.example.test/v1", defaultModel: "r1", format: "responses", curated: [], auth: "api_key", authMethods: ["api_key"] };
const noWait = async () => {};

/** The fake CLI behind `_supercharge/setup/<op>`, recording every call (and erroring like ACP). */
function fake() {
  const f = fakeSetup(undefined, [BROWSER, ROUTER]), calls: [string, any][] = [];
  const api = cliProviders(async (op, p) => {
    calls.push([op, p]);
    const r = await f.run(op, p);
    return op === "models" ? { models: r } : r;
  });
  return { api, calls, f };
}

describe("provider catalogue client", () => {
  it("lists every provider with the CLI's fields and no secrets", async () => {
    const { api } = fake();
    const l = await api.list();
    expect(l.activeProviderId).toBeNull();
    expect(l.configPath).toContain("config.toml");
    const ids = l.providers.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["openai", "nous", "ollama", "mistral-auth", "router"]));
    const router = l.providers.find((p) => p.id === "router")!;
    expect(router).toMatchObject({ formatName: "Responses", custom: false, hasApiKey: false, active: false, ready: false, modelsSource: "live" });
    expect(JSON.stringify(l)).not.toMatch(/apiKey"?\s*:\s*"[^"]/);
  });

  it("sends the contract's request shapes", async () => {
    const { api, calls } = fake();
    await api.setKey("router", "sk-good");
    await api.setKey("router", "sk-good", false);
    await api.status("router");
    await api.models("router");
    await api.use("router", "model-a", "Model A", "s1");
    await api.addCustom({ name: "My Gateway", baseUrl: "https://gw.example.test/v1", format: "anthropic", apiKey: "", validate: false });
    await api.remove("custom-my-gateway");
    expect(calls).toEqual([
      ["provider_set_key", { providerId: "router", apiKey: "sk-good" }],
      ["provider_set_key", { providerId: "router", apiKey: "sk-good", validate: false }],
      ["provider_status", { providerId: "router" }],
      ["models", { providerId: "router" }],
      ["save", { providerId: "router", modelId: "model-a", modelName: "Model A", sessionId: "s1" }],
      // An empty key is dropped (the CLI keeps the saved one), as are unset fields.
      ["provider_add_custom", { name: "My Gateway", baseUrl: "https://gw.example.test/v1", format: "anthropic", validate: false }],
      ["provider_remove", { providerId: "custom-my-gateway" }],
    ]);
  });

  it("API-key flow: set key, ready, models, save makes it active", async () => {
    const { api } = fake();
    await expect(api.setKey("router", "bad")).rejects.toThrow(/rejected the key/);
    expect((await api.status("router")).hasApiKey).toBe(false);
    const r = await api.setKey("router", "sk-good");
    expect(r.models.map((m) => m.id)).toContain("model-a");
    expect(r.models[0]).toEqual({ id: "model-a", name: "Model A", context: 200000 });
    expect(await untilReady(api, "router", 1, noWait)).toMatchObject({ ready: true, hasApiKey: true });
    await api.use("router", "model-b");
    const l = await api.list();
    expect(l).toMatchObject({ activeProviderId: "router", activeModelId: "model-b" });
    expect(l.providers.find((p) => p.id === "router")?.active).toBe(true);
    await expect(api.remove("router")).rejects.toThrow(/active provider/);
  });

  it("refuses a key for sign-in providers", async () => {
    const { api } = fake();
    await expect(api.setKey("nous", "sk")).rejects.toThrow(/auth_start/);
  });

  it("custom provider: id from the name, not active until saved, removable", async () => {
    const { api } = fake();
    await expect(api.addCustom({ name: "Gw", baseUrl: "http://10.0.0.5/v1" })).rejects.toThrow(/loopback/);
    const r = await api.addCustom({ name: "My Gateway", baseUrl: "https://gw.example.test/v1/", apiKey: "sk-1" });
    expect(r.provider).toMatchObject({ id: "custom-my-gateway", custom: true, active: false, hasApiKey: true, ready: true, baseUrl: "https://gw.example.test/v1" });
    expect(r.models.length).toBe(3);
    expect(removable(r.provider)).toBe(true);
    expect((await api.remove("custom-my-gateway")).removed).toBe(true);
    expect((await api.list()).providers.some((p) => p.id === "custom-my-gateway")).toBe(false);
  });

  it("device-code and browser sign-in wait for done, then the provider is ready", async () => {
    for (const [id, kind] of [["nous", "device"], ["mistral-auth", "browser"]] as const) {
      const { api } = fake();
      const shown: any[] = [];
      const done = await signInFlow(api, id, kind, { shown: (s) => shown.push(s), cancelled: () => false, wait: noWait });
      expect(done.status).toBe("done");
      expect(shown[0].url).toMatch(/^https:\/\//);
      if (kind === "device") expect(shown[0].userCode).toBe("WDJB-MJHT"); else expect(shown[0].userCode).toBeUndefined();
      expect(await untilReady(api, id, 1, noWait)).toMatchObject({ signedIn: true, ready: true });
    }
  });

  it("untilReady gives up with a readable error", async () => {
    const { api } = fake();
    await expect(untilReady(api, "router", 2, noWait)).rejects.toThrow(/not ready/);
  });
});

describe("older CLIs", () => {
  const missing = () => new AcpRpcError(-32601, "Method not found: _supercharge/setup/providers_list");
  it("detects method-not-found", () => {
    expect(isMissingMethod(missing())).toBe(true);
    expect(isMissingMethod({ code: -32603, message: "Method not found" })).toBe(true);
    expect(isMissingMethod(new AcpRpcError(-32602, "Invalid params: bad key"))).toBe(false);
    expect(isMissingMethod(new Error("timeout"))).toBe(false);
  });
  it("offers the catalogue api whenever the agent has setup methods; a CLI without any gets null", async () => {
    const client = (methods: string[]) => ({ hasExtension: (m: string) => methods.includes(m), ext: async () => { throw missing(); } });
    expect(agentProviders(null)).toBeNull();
    expect(agentProviders(client([]))).toBeNull();
    const old = agentProviders(client(["_supercharge/setup/save"]))!;
    await expect(old.list()).rejects.toSatisfy(isMissingMethod);
  });
  it("finds the CLI's `_supercharge/setup/methods` capability list", () => {
    const ext = discoverExtensions({ protocolVersion: 1, agentCapabilities: { _meta: { "_supercharge/setup": true, "_supercharge/setup/methods": ["_supercharge/setup/save", "_supercharge/setup/providers_list"] } } } as any);
    expect(ext.methods).toEqual(expect.arrayContaining(["_supercharge/setup/save", "_supercharge/setup/providers_list"]));
  });
});

describe("auth-method helpers", () => {
  it("builds the UI only from authMethods", () => {
    expect(signInKinds({ id: "a", name: "A", authMethods: ["device"] })).toEqual(["device"]);
    expect(takesKey({ id: "a", name: "A", authMethods: ["device"] })).toBe(false);
    expect(keyOptional({ id: "o", name: "O", authMethods: ["none", "api_key"] })).toBe(true);
    expect(isSetUp({ id: "x", name: "X", authMethods: ["api_key"] })).toBe(false);
    expect(isSetUp({ id: "x", name: "X", hasApiKey: true })).toBe(true);
    expect(removable({ id: "x", name: "X", hasApiKey: true, active: true })).toBe(false);
    expect(formatChoices([{ id: "r", name: "R", format: "responses", formatName: "Responses API" }])).toEqual([["openai", "Chat Completions"], ["anthropic", "Messages"], ["responses", "Responses API"]]);
    expect(toModels({ models: [{ id: "m", name: "", contextWindow: null }, {}] })).toEqual([{ id: "m", name: "m" }]);
    expect(errText(new Error("Invalid params: provider rejected the key"))).toBe("provider rejected the key");
  });
});
