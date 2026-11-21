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
  // The provider catalogue (`providers_list`, `provider_*`): keys per provider, custom providers.
  const keys = new Set<string>(saved.providerId && (saved.hasApiKey || saved.hasKey) ? [saved.providerId] : []);
  const customs: any[] = [];
  const FMT_NAME: Record<string, string> = { openai: "Chat Completions", anthropic: "Messages", responses: "Responses" };
  const row = (id: string) => (catalog as any[]).find((c) => c.id === id) ?? customs.find((c) => c.id === id);
  const methodsOf = (c: any): string[] => c.authMethods ?? (c.auth === "oauth_device" ? ["device"] : ["api_key"]);
  const info = (c: any) => {
    const m = methodsOf(c), optional = !!c.keyOptional || m.includes("none");
    const signedIn = kinds(c.id).length ? isIn(c.id) : null;
    const hasApiKey = keys.has(c.id);
    const base = String(c.baseUrl ?? "").replace(/\/+$/, "");
    return { ...c, authMethods: m, keyOptional: optional, signedIn, formatName: FMT_NAME[c.format] ?? "Chat Completions", custom: !!c.custom, hasApiKey, active: saved.providerId === c.id, ready: optional || hasApiKey || signedIn === true, modelsSource: "live", modelsUrl: `${base}/models` };
  };
  const known = (id: unknown) => { const c = row(String(id ?? "")); if (!c) throw invalid(`Unknown provider: ${id}`); return c; };
  const MODELS = [{ id: "model-a", name: "Model A", supportsThinking: false, contextWindow: 200000 }, { id: "model-b", name: "Model B", supportsThinking: false, contextWindow: null }, { id: "vendor/model-c", name: "vendor/model-c", supportsThinking: false, contextWindow: null }];
  const checkKey = (k: unknown) => { if (k === "bad") throw invalid("provider rejected the key: HTTP 401 invalid API key"); };
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
          // Like the CLI's browser sign-in: the issued key makes the provider active with its default model.
          if (login.kind === "browser") { const c = row(login.providerId); Object.assign(saved, { providerId: c?.id, baseUrl: c?.baseUrl, format: c?.format, model: c?.defaultModel }); }
          notify?.("_supercharge/setup/auth_changed", { ...login });
        }
        return { ...login };
      }
      case "auth_cancel": {
        const ok = !!login && p.loginId === login.loginId && login.status === "pending";
        if (ok) login = null;
        return { cancelled: ok };
      }
      case "providers_list":
        return { activeProviderId: saved.providerId ?? null, activeModelId: saved.model ?? saved.modelId ?? null, configPath: "/home/u/.supercharge/config.toml", providers: [...(catalog as any[]), ...customs].map(info) };
      case "provider_status": return info(known(p.providerId));
      case "provider_add_custom": {
        const name = String(p.name ?? "").trim();
        let url = String(p.baseUrl ?? "").trim().replace(/\/+$/, "");
        if (!name) throw invalid("name is required");
        if (!url) throw invalid("baseUrl is required");
        if (!url.includes("://")) url = `https://${url}`;
        const host = (() => { try { return new URL(url).hostname; } catch { throw invalid("baseUrl is not a valid URL"); } })();
        if (url.startsWith("http://") && !["127.0.0.1", "localhost", "[::1]"].includes(host)) throw invalid("http:// is only allowed for loopback addresses; use https://");
        const format = p.format ?? "openai";
        if (!["openai", "anthropic", "responses"].includes(format)) throw invalid(`unknown format: ${format}`);
        const id = p.id ?? `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
        if ((catalog as any[]).some((c) => c.id === id)) throw invalid(`id ${id} is a built-in provider`);
        if (p.apiKey !== undefined) checkKey(p.apiKey);
        const def = { id, name, description: "Custom provider", baseUrl: url, defaultModel: "", format, curated: [], auth: "api_key", authMethods: ["api_key"], keyOptional: false, custom: true };
        const at = customs.findIndex((c) => c.id === id);
        if (at >= 0) customs[at] = def; else customs.push(def);
        if (p.apiKey) keys.add(id);
        return { provider: info(def), models: p.validate === false ? [] : MODELS };
      }
      case "provider_set_key": {
        const c = known(p.providerId);
        if (!methodsOf(c).includes("api_key")) throw invalid(`${c.name} takes no API key; use auth_start`);
        if (!String(p.apiKey ?? "").trim()) throw invalid("apiKey is required");
        if (p.validate !== false) checkKey(p.apiKey);
        keys.add(c.id);
        return { saved: true, providerId: c.id, active: saved.providerId === c.id, reloaded: saved.providerId === c.id, models: p.validate === false ? [] : MODELS, provider: info(c) };
      }
      case "provider_remove": {
        const c = known(p.providerId);
        if (saved.providerId === c.id) throw invalid(`${c.name} is the active provider; switch to another provider with setup/save first`);
        const had = keys.delete(c.id) || signed.delete(c.id) || (c.id === "nous" && saved.nousSignedIn && !(saved.nousSignedIn = false));
        const ci = customs.findIndex((x) => x.id === c.id);
        if (ci >= 0) customs.splice(ci, 1);
        return { removed: had || ci >= 0, providerId: c.id };
      }
      case "models":
        // Catalogue-style call (providerId only): a key provider needs its stored key.
        if (p.baseUrl === undefined && p.apiKey === undefined && row(String(p.providerId)) && !info(row(String(p.providerId))).ready) throw invalid("No API key saved for this provider. Add one with provider_set_key.");
        if (kinds(String(p.providerId)).length && !isIn(String(p.providerId))) throw new Error("Not signed in. Sign in first.");
        if (p.apiKey === "bad") throw new Error("provider returned HTTP 401: invalid API key");
        return [{ id: "model-a", name: "Model A", context: 200000 }, { id: "model-b", name: "Model B" }, { id: "vendor/model-c", name: "vendor/model-c" }];
      case "save":
        if (p.baseUrl === undefined && row(String(p.providerId))) { const c = row(String(p.providerId)); p = { ...p, baseUrl: c.baseUrl, format: c.format }; if (keys.has(c.id)) saved.hasKey = true; }
        saves.push({ ...p, apiKey: p.apiKey === undefined ? "(kept)" : p.apiKey ? "(set)" : "(none)" });
        Object.assign(saved, { providerId: p.providerId, baseUrl: p.baseUrl, format: p.format, model: p.modelId, hasKey: saved.hasKey && p.apiKey === undefined ? true : !!p.apiKey || p.providerId === "nous" });
        return { ...saved };
      case "device_start": polls = 0; return { userCode: "WDJB-MJHT", verificationUri: "https://portal.nousresearch.com/oauth/device?user_code=WDJB-MJHT", expiresIn: 900, interval: 1 };
      case "device_poll": if (++polls < 2) return "pending"; saved.nousSignedIn = true; return "done";
      case "device_cancel": return {};
    }
    throw new Error("Unknown setup step");
  };
  return { run, saves, keys };
}
