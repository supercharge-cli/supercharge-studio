import { PROVIDERS } from "../src/lib/setup";

/** The CLI's own catalog in its `setup/status` shape: formats openai/anthropic/responses, auth kind. */
const CLI_FORMAT = { chat_completions: "openai", messages: "anthropic", responses: "responses" } as const;
const CLI_CATALOG = PROVIDERS.map((p) => ({ id: p.id, name: p.name, description: p.description, baseUrl: p.baseUrl, defaultModel: p.defaultModel, format: CLI_FORMAT[p.format], curated: true, auth: p.device ? "oauth_device" : "api_key" }));

/** Scripted provider setup for the fakes: models, save and a two-poll device-code login. */
export function fakeSetup(preset?: Record<string, unknown>) {
  // FAKE_AGENT_SETUP_UNLISTED=1 seeds a CLI connected to a provider only its own catalog has (not the
  // app's fallback list), reported in the CLI's raw status shape (modelId/hasApiKey).
  const seeded = !!process.env.FAKE_AGENT_SETUP_UNLISTED;
  const catalog = seeded
    ? [...CLI_CATALOG, { id: "agentrouter", name: "AgentRouter", description: "Aggregator via AgentRouter", baseUrl: "https://api.agentrouter.org/v1", defaultModel: "gpt-5.6-sol", format: "responses", curated: false, auth: "api_key" }]
    : CLI_CATALOG;
  const saved: any = seeded
    ? { providerId: "agentrouter", baseUrl: "https://api.agentrouter.org/v1", format: "responses", modelId: "gpt-5.6-sol", hasApiKey: true, nousSignedIn: false, providers: catalog }
    : { providerId: null, baseUrl: null, format: null, model: null, hasKey: false, nousSignedIn: false, ...preset };
  let polls = 0;
  const saves: any[] = [];
  const run = async (op: string, p: any = {}): Promise<any> => {
    switch (op) {
      case "status": return { ...saved, providers: catalog };
      case "models":
        if (p.providerId === "nous" && !saved.nousSignedIn) throw new Error("Nous Portal is not signed in. Sign in with Nous Research first.");
        if (p.apiKey === "bad") throw new Error("provider returned HTTP 401: invalid API key");
        return [{ id: "model-a", name: "Model A", context: 200000 }, { id: "model-b", name: "Model B" }, { id: "vendor/model-c", name: "vendor/model-c" }];
      case "save":
        saves.push({ ...p, apiKey: p.apiKey === undefined ? "(kept)" : p.apiKey ? "(set)" : "(none)" });
        Object.assign(saved, { providerId: p.providerId, baseUrl: p.baseUrl, format: p.format, model: p.modelId, hasKey: saved.hasKey && p.apiKey === undefined ? true : !!p.apiKey || p.providerId === "nous" });
        return { ...saved };
      case "device_start": polls = 0; return { userCode: "WDJB-MJHT", verificationUri: "https://portal.nousresearch.com/oauth/device?user_code=WDJB-MJHT", expiresIn: 900, interval: 1 };
      case "device_poll": if (++polls < 2) return "pending"; saved.nousSignedIn = true; return "done";
      case "device_cancel": return {};
    }
    throw new Error("Unknown setup step");
  };
  return { run, saves };
}
