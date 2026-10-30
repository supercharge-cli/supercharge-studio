/** Scripted provider setup for the fakes: models, save and a two-poll device-code login. */
export function fakeSetup(preset?: Record<string, unknown>) {
  // FAKE_AGENT_SETUP_UNLISTED=1 seeds a CLI connected to a provider the app's list does not know,
  // reported in the CLI's raw status shape (modelId/hasApiKey) with its own provider catalog.
  const seeded = !!process.env.FAKE_AGENT_SETUP_UNLISTED;
  const catalog = [{ id: "agentrouter", name: "AgentRouter", description: "Aggregator via AgentRouter", baseUrl: "https://api.agentrouter.org/v1", defaultModel: "gpt-5.6-sol", format: "responses" }];
  const saved: any = seeded
    ? { providerId: "agentrouter", baseUrl: "https://api.agentrouter.org/v1", format: "responses", modelId: "gpt-5.6-sol", hasApiKey: true, nousSignedIn: false, providers: catalog }
    : { providerId: null, baseUrl: null, format: null, model: null, hasKey: false, nousSignedIn: false, providers: catalog, ...preset };
  let polls = 0;
  const saves: any[] = [];
  const run = async (op: string, p: any = {}): Promise<any> => {
    switch (op) {
      case "status": return { ...saved, ...(seeded ? {} : { providers: catalog }) };
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
