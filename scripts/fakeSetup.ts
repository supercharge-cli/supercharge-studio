import { CLI_CATALOG } from "./cliCatalog";

const DEVICE_URL = "https://portal.nousresearch.com/oauth/device?user_code=WDJB-MJHT";

/**
 * Scripted provider setup for the fakes: models, save, a two-poll device-code login (`device_*`) and
 * the CLI sign-in (`auth_*`, two polls then done + `auth_changed`). `extra`: more catalog rows.
 */
export function fakeSetup(preset?: Record<string, unknown>, extra: Record<string, unknown>[] = []) {
  // FAKE_AGENT_SETUP_UNLISTED=1 seeds a CLI connected to a provider only its own catalog has (not the
  // app's fallback list), reported in the CLI's raw status shape (modelId/hasApiKey).
  const seeded = !!process.env.FAKE_AGENT_SETUP_UNLISTED;
  const catalog = seeded
    ? [...CLI_CATALOG, { id: "agentrouter", name: "AgentRouter", description: "Aggregator via AgentRouter", baseUrl: "https://api.agentrouter.org/v1", defaultModel: "gpt-5.6-sol", format: "responses", curated: false, auth: "api_key" }]
    : [...CLI_CATALOG, ...extra];
  const saved: any = seeded
    ? { providerId: "agentrouter", baseUrl: "https://api.agentrouter.org/v1", format: "responses", modelId: "gpt-5.6-sol", hasApiKey: true, nousSignedIn: false, providers: catalog }
    : { providerId: null, baseUrl: null, format: null, model: null, hasKey: false, nousSignedIn: false, providers: catalog, ...preset };
  let polls = 0, logins = 0;
  const saves: any[] = [];
  const signed = new Set<string>();
  let login: any = null;
  const kinds = (id: string): string[] => ((catalog as any[]).find((c) => c.id === id)?.authMethods ?? []).filter((k: string) => k !== "api_key");
  const isIn = (id: string) => signed.has(id) || (id === "nous" && !!saved.nousSignedIn);
  const invalid = (m: string) => Object.assign(new Error(m), { code: -32602 });
  const run = async (op: string, p: any = {}, notify?: (method: string, params: unknown) => void): Promise<any> => {
    switch (op) {
      case "status": return {
        ...saved,
        providers: (catalog as any[]).map((c) => ({ ...c, signedIn: kinds(c.id).length ? isIn(c.id) : null })),
        oauth: Object.fromEntries((catalog as any[]).filter((c) => kinds(c.id).length).map((c) => [c.id, { signedIn: isIn(c.id) }])),
        authLogin: login && { ...login },
      };
      case "auth_start": {
        const ks = kinds(String(p.providerId));
        if (!ks.length) throw invalid("Provider has no sign-in");
        if (p.kind && !ks.includes(p.kind)) throw invalid("Unsupported sign-in kind");
        const kind = p.kind ?? ks[0];
        login = { loginId: `login-${++logins}`, providerId: p.providerId, kind, status: "pending", interval: 1 };
        polls = 0;
        return { loginId: login.loginId, providerId: p.providerId, kind, url: kind === "device" ? DEVICE_URL : `https://auth.example.test/authorize?login=${login.loginId}`, ...(kind === "device" ? { userCode: "WDJB-MJHT" } : {}), expiresIn: 900, interval: 1 };
      }
      case "auth_poll": {
        if (!login || p.loginId !== login.loginId) throw invalid("Unknown login");
        if (login.status === "pending" && ++polls >= 2) {
          login.status = "done";
          signed.add(login.providerId);
          if (login.providerId === "nous") saved.nousSignedIn = true;
          notify?.("_supercharge/setup/auth_changed", { ...login });
        }
        return { ...login };
      }
      case "auth_cancel": {
        const ok = !!login && p.loginId === login.loginId && login.status === "pending";
        if (ok) login = null;
        return { cancelled: ok };
      }
      case "models":
        if (kinds(String(p.providerId)).length && !isIn(String(p.providerId))) throw new Error("Not signed in. Sign in first.");
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
