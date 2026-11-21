/**
 * The CLI's provider catalogue over ACP (`_supercharge/setup/providers_list` and friends).
 * The CLI owns every provider: the list, sign-ins, keys and config. Studio only renders what
 * these calls return and sends what the user types. No response carries a key or token.
 */
import { waitAuth, type AuthKind, type AuthLogin, type AuthStart, type SetupModel } from "./setup";

/** Wire format of a provider, as the CLI sends it. */
export type WireFormat = "openai" | "anthropic" | "responses";
export type ProviderInfo = {
  id: string; name: string; description?: string; baseUrl?: string; defaultModel?: string;
  format?: WireFormat | string; formatName?: string; curated?: unknown; custom?: boolean;
  authMethods?: string[]; keyOptional?: boolean; signedIn?: boolean | null; hasApiKey?: boolean;
  active?: boolean; ready?: boolean; modelsSource?: string; modelsUrl?: string;
};
export type ProvidersList = { activeProviderId: string | null; activeModelId: string | null; configPath?: string; providers: ProviderInfo[] };
export type CustomReq = { name: string; baseUrl: string; format?: WireFormat; apiKey?: string; id?: string; validate?: boolean };
export type UseResult = { saved?: boolean; modelId?: string; reloaded?: boolean; switchedSessions?: string[]; message?: string };

export const PROVIDER_METHODS = ["providers_list", "provider_status", "provider_add_custom", "provider_set_key", "provider_remove"] as const;

export interface ProvidersApi {
  list(): Promise<ProvidersList>;
  status(providerId: string): Promise<ProviderInfo>;
  addCustom(r: CustomReq): Promise<{ provider: ProviderInfo; models: SetupModel[] }>;
  setKey(providerId: string, apiKey: string, validate?: boolean): Promise<{ provider?: ProviderInfo; models: SetupModel[]; active?: boolean }>;
  remove(providerId: string): Promise<{ removed: boolean; providerId: string }>;
  models(providerId: string): Promise<SetupModel[]>;
  /** `setup/save { providerId, modelId }`: the CLI resolves the URL, format and stored key itself. */
  use(providerId: string, modelId: string, modelName?: string, sessionId?: string): Promise<UseResult>;
  authStart(providerId: string, kind?: AuthKind): Promise<AuthStart>;
  authPoll(loginId: string): Promise<AuthLogin>;
  authCancel(loginId: string): Promise<{ cancelled: boolean }>;
}

/** The CLI's Model shape (`contextWindow`) as the app's. */
export const toModels = (r: any): SetupModel[] =>
  (Array.isArray(r) ? r : r?.models ?? []).filter((m: any) => m?.id).map((m: any) => ({ id: String(m.id), name: String(m.name || m.id), ...(m.contextWindow ?? m.context ? { context: Number(m.contextWindow ?? m.context) } : {}) }));

/** `call(op, params)` sends `_supercharge/setup/<op>`. */
export function cliProviders(call: (op: string, params: Record<string, unknown>) => Promise<any>): ProvidersApi {
  return {
    list: () => call("providers_list", {}).then((r) => ({ activeProviderId: r?.activeProviderId ?? null, activeModelId: r?.activeModelId ?? null, configPath: r?.configPath, providers: (Array.isArray(r?.providers) ? r.providers : []).filter((p: any) => p?.id) })),
    status: (providerId) => call("provider_status", { providerId }),
    addCustom: (r) => call("provider_add_custom", Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v !== ""))).then((x) => ({ provider: x?.provider, models: toModels(x?.models) })),
    setKey: (providerId, apiKey, validate) => call("provider_set_key", validate === false ? { providerId, apiKey, validate } : { providerId, apiKey }).then((x) => ({ provider: x?.provider, active: !!x?.active, models: toModels(x?.models) })),
    remove: (providerId) => call("provider_remove", { providerId }).then((x) => ({ removed: !!x?.removed, providerId: x?.providerId ?? providerId })),
    models: (providerId) => call("models", { providerId }).then(toModels),
    use: (providerId, modelId, modelName, sessionId) => call("save", { providerId, modelId, ...(modelName && modelName !== modelId ? { modelName } : {}), ...(sessionId ? { sessionId } : {}) }),
    authStart: (providerId, kind) => call("auth_start", kind ? { providerId, kind } : { providerId }),
    authPoll: (loginId) => call("auth_poll", { loginId }),
    authCancel: (loginId) => call("auth_cancel", { loginId }).then((r) => ({ cancelled: !!r?.cancelled })),
  };
}

type ExtClient = { hasExtension(m: string): boolean; ext<T = any>(m: string, p?: unknown): Promise<T> };
/**
 * The connected agent's provider catalogue, or null when the agent offers no setup methods at all.
 * An agent that offers setup but predates the catalogue still gets an api: its first call fails
 * with method-not-found (see `isMissingMethod`) and the caller falls back to the older setup.
 */
export function agentProviders(client?: ExtClient | null): ProvidersApi | null {
  if (!client || !["save", "status", "providers_list"].some((op) => client.hasExtension(`_supercharge/setup/${op}`))) return null;
  return cliProviders((op, p) => client.ext(`_supercharge/setup/${op}`, p));
}

/** JSON-RPC "method not found": a CLI from before the provider catalogue. */
export const isMissingMethod = (e: unknown) => (e as any)?.code === -32601 || /method not found/i.test(String((e as any)?.message ?? ""));

/** The CLI's error text without the JSON-RPC prefix. */
export const errText = (e: unknown) => String((e as any)?.message ?? e).replace(/^(invalid params|internal error):\s*/i, "");

/** Sign-in kinds the provider offers, in the CLI's order. */
export const signInKinds = (p: ProviderInfo): AuthKind[] => (p.authMethods ?? []).filter((k): k is AuthKind => k === "device" || k === "browser");
/** Whether the provider takes a pasted key (never show a key field otherwise). */
export const takesKey = (p: ProviderInfo) => (p.authMethods ?? []).includes("api_key");
/** Whether the provider works with no credential (local servers). */
export const keyOptional = (p: ProviderInfo) => !!p.keyOptional || (p.authMethods ?? []).includes("none");
/** Set up in the CLI: active, custom, a stored key or a sign-in. Local servers count once active. */
export const isSetUp = (p: ProviderInfo) => !!(p.active || p.custom || p.hasApiKey || p.signedIn === true);
/** Something the CLI can forget: a custom provider, a stored key or a sign-in, never the active one. */
export const removable = (p: ProviderInfo) => !p.active && !!(p.custom || p.hasApiKey || p.signedIn === true);

/** Format choices for a custom provider: the labels the CLI sends with its own providers. */
export function formatChoices(list: ProviderInfo[]): [WireFormat, string][] {
  const label = (f: WireFormat, d: string) => list.find((p) => p.format === f && p.formatName)?.formatName ?? d;
  return [["openai", label("openai", "Chat Completions")], ["anthropic", label("anthropic", "Messages")], ["responses", label("responses", "Responses")]];
}

/** Picker filter on id, name and description. */
export const filterInfo = (list: ProviderInfo[], q: string) => {
  const t = q.trim().toLowerCase();
  return t ? list.filter((p) => p.id.toLowerCase().includes(t) || p.name.toLowerCase().includes(t) || (p.description ?? "").toLowerCase().includes(t)) : list;
};

/**
 * Sign in through the CLI and wait until it reports `done` (poll every `interval`, or the
 * `auth_changed` notification). `shown` gets the URL and code to show; `cancelled` stops waiting.
 */
export async function signInFlow(api: ProvidersApi, providerId: string, kind: AuthKind | undefined, h: { shown: (s: AuthStart) => void; cancelled: () => boolean; wait?: (ms: number) => Promise<unknown> }): Promise<AuthLogin> {
  const s = await api.authStart(providerId, kind);
  if (h.cancelled()) { void api.authCancel(s.loginId).catch(() => {}); throw new Error("cancelled"); }
  h.shown(s);
  return waitAuth(api, s, h.cancelled, h.wait as any);
}

/** Wait until the CLI reports the provider `ready` (a few quick checks after a sign-in or key save). */
export async function untilReady(api: Pick<ProvidersApi, "status">, providerId: string, tries = 5, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<ProviderInfo> {
  let p = await api.status(providerId);
  for (let i = 1; i < tries && !p?.ready; i++) { await wait(600); p = await api.status(providerId); }
  if (!p?.ready) throw new Error(`${p?.name ?? providerId} is not ready yet. Try again in a moment.`);
  return p;
}

