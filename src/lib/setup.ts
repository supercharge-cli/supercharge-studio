/**
 * Provider setup, the same as the CLI's `/setup`: the same provider list (names, descriptions,
 * order), the same steps, and a config.toml the CLI reads. Three backends share one shape:
 * the desktop shell (Tauri), an agent that advertises `_supercharge/setup/*` over ACP, and
 * the phone, which asks the paired computer through the gateway.
 */
import { invoke, isDesktop } from "./desktop";
import type { ModelOpt } from "./modelFallback";
import type { Provider } from "./store";

export type Fmt = "chat_completions" | "messages" | "responses";
/**
 * `device`/`browser`: the CLI signs in for this provider (`authMethods`); `noKey`: no API-key path.
 * `signedIn`: the CLI's sign-in state (null for key-only providers).
 */
export type SetupProvider = { id: string; name: string; description: string; baseUrl: string; defaultModel: string; format: Fmt; keyOptional?: boolean; device?: boolean; browser?: boolean; noKey?: boolean; signedIn?: boolean | null };
/** Custom endpoint: the one row the app adds itself. The provider list comes from the CLI (`setup/status`). */
export const CUSTOM: SetupProvider = { id: "custom", name: "Custom / paste a base URL", description: "", baseUrl: "", defaultModel: "", format: "chat_completions", keyOptional: true };

export const FORMATS: [Fmt, string, string][] = [["chat_completions", "Chat Completions", "/chat/completions"], ["messages", "Messages", "/messages"], ["responses", "Responses", "/responses"]];

/** The CLI's `setup/status` catalog, in the CLI's order. Null when this agent did not send one. */
export function providersFromStatus(status?: SetupStatusFull | null): SetupProvider[] | null {
  const c = providerCatalog(status);
  return c.length ? c : null;
}

/** Type-to-filter, as in the CLI: id, name or description; Custom matches "custom", "openai", "base url". */
export function filterProviders(query: string, extra?: SetupProvider | null, catalog?: SetupProvider[] | null): SetupProvider[] {
  const q = query.trim().toLowerCase();
  const rows = (catalog ?? []).filter((p) => !q || p.id.includes(q) || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  if (extra && (!q || extra.id.includes(q) || extra.name.toLowerCase().includes(q) || extra.description.toLowerCase().includes(q))) rows.push(extra);
  if (!q || "custom".includes(q) || "openai".includes(q) || "base url".includes(q)) rows.push(CUSTOM);
  return rows;
}

export type SetupModel = { id: string; name: string; context?: number };
export const CUSTOM_MODEL = "__custom__";
/** Model filter plus the trailing "Type a custom model id…" row. */
export function filterModels(models: SetupModel[], query: string): SetupModel[] {
  const q = query.trim().toLowerCase();
  const rows = models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  if (!q || "custom".includes(q) || "type".includes(q)) rows.push({ id: CUSTOM_MODEL, name: "Type a custom model id…" });
  return rows;
}

export type SetupStatus = { providerId?: string | null; baseUrl?: string | null; format?: string | null; model?: string | null; hasKey: boolean; nousSignedIn: boolean; authLogin?: AuthLogin | null };

// ---- CLI sign-in (`_supercharge/setup/auth_*`). Credentials never cross ACP: only ids, URL, code, status. ----
export type AuthKind = "device" | "browser";
export type AuthStart = { loginId: string; providerId: string; kind: AuthKind; url: string; userCode?: string; expiresIn: number; interval: number };
export type AuthStatus = "pending" | "done" | "denied" | "expired" | "error";
export type AuthLogin = { loginId: string; providerId: string; kind: AuthKind; status: AuthStatus; interval: number; message?: string };

/** One entry of the CLI's own provider catalog, sent in `setup/status` `providers`. */
export type CliProvider = { id: string; name?: string; description?: string; baseUrl?: string; defaultModel?: string; format?: string; curated?: boolean; auth?: string; authMethods?: string[]; keyOptional?: boolean; signedIn?: boolean | null };
export type SetupStatusFull = SetupStatus & { providers?: CliProvider[] };

/**
 * Map the raw `setup/status` payload to the app's shape. The desktop shell already sends
 * `model`/`hasKey`/`nousSignedIn` (camelCase via serde); the agent and gateway paths pass the
 * CLI's raw `modelId`/`hasApiKey`/`oauth.nous.signedIn` through.
 */
export function normalizeStatus(raw: any): SetupStatusFull {
  const r = raw ?? {};
  const status: SetupStatusFull = {
    providerId: r.providerId ?? null,
    baseUrl: r.baseUrl ?? null,
    format: r.format ?? null,
    model: r.model ?? r.modelId ?? null,
    hasKey: !!(r.hasKey ?? r.hasApiKey),
    nousSignedIn: !!(r.nousSignedIn ?? r.oauth?.nous?.signedIn),
  };
  if (Array.isArray(r.providers)) status.providers = r.providers;
  if (r.authLogin !== undefined) status.authLogin = r.authLogin;
  return status;
}

/**
 * The provider list to offer: the CLI's own catalog from `setup/status` `providers` (its order,
 * names, URLs, default models; `oauth_device` = device login). Empty without one: only Custom is offered.
 */
export function providerCatalog(status: SetupStatusFull | null | undefined): SetupProvider[] {
  const rows = (status?.providers ?? []).filter((p) => p?.id && p.id !== CUSTOM.id);
  return rows.map((p) => {
    const m = Array.isArray(p.authMethods) ? p.authMethods : null;
    return {
      id: p.id,
      name: p.name || p.id,
      description: p.description ?? "",
      baseUrl: p.baseUrl ?? "",
      defaultModel: p.defaultModel ?? "",
      format: asFmt(p.format),
      // Local servers: the CLI reports keyOptional / authMethods "none"; the key field stays, not required.
      ...(p.keyOptional || m?.includes("none") ? { keyOptional: true } : {}),
      ...((m ? m.includes("device") : p.auth === "oauth_device") ? { device: true } : {}),
      ...(m?.includes("browser") ? { browser: true } : {}),
      ...(m && !m.includes("api_key") ? { noKey: true } : {}),
      ...(typeof p.signedIn === "boolean" ? { signedIn: p.signedIn } : {}),
    };
  });
}

/** A CLI-connected provider missing from the catalog in use (e.g. an id saved by hand in the CLI config). */
export function unlistedProvider(status: SetupStatusFull | null | undefined, catalog = providerCatalog(status)): SetupProvider | null {
  const id = status?.providerId?.trim();
  if (!id || id === CUSTOM.id || catalog.some((p) => p.id === id)) return null;
  const from = status!.providers?.find((p) => p?.id === id);
  return {
    id,
    name: from?.name || id,
    description: from?.description || "Connected in the CLI",
    baseUrl: from?.baseUrl ?? status!.baseUrl ?? "",
    defaultModel: from?.defaultModel ?? status!.model ?? "",
    format: asFmt(from?.format ?? status!.format),
  };
}
/**
 * `apiKey` undefined keeps the saved key when the base URL matches (or uses the Nous login token).
 * `sessionId`: the chat to switch right away; agents with `_supercharge/setup/save` take it
 * (omitted = every open chat). The desktop shell ignores it.
 */
export type SaveReq = { providerId: string; baseUrl: string; apiKey?: string; format: Fmt; modelId: string; modelName?: string; sessionId?: string };
/** An agent save reports the chats it already switched; then no restart is needed. */
export type SaveResult = SetupStatus & { switchedSessions?: string[] };

/** Base URL as `/setup` compares it: https added, trailing `/` and `/models` dropped, lowercased. */
export function normBase(u?: string | null): string {
  let t = (u ?? "").trim();
  if (!t) return "";
  if (!t.includes("://")) t = `https://${t}`;
  t = t.replace(/\/+$/, "").replace(/\/models$/i, "").replace(/\/+$/, "");
  return t.toLowerCase();
}
/** The saved key is reused only for the same base URL, so a key never goes to another provider. */
export const keyReusable = (status: SetupStatus | null | undefined, baseUrl: string) =>
  !!status?.hasKey && !!normBase(baseUrl) && normBase(status.baseUrl) === normBase(baseUrl);
/** True when the save already applied to running chats (no agent restart needed). */
export const switchedLive = (r: unknown) => Array.isArray((r as SaveResult | null)?.switchedSessions);
export type DeviceStart = { userCode: string; verificationUri: string; expiresIn: number; interval: number };

/** Whether the CLI is signed in for a sign-in provider (its catalog; older CLIs: the device login flag). */
export const isSignedIn = (status: SetupStatusFull | null | undefined, p: SetupProvider) => !!(p.signedIn ?? (p.device && status?.nousSignedIn));

export interface SetupApi {
  status(): Promise<SetupStatus>;
  models(providerId: string, baseUrl: string, apiKey: string | undefined, format: Fmt): Promise<SetupModel[]>;
  save(r: SaveReq): Promise<SaveResult>;
  deviceStart(): Promise<DeviceStart>;
  /** One token check: "pending" | "slow_down" | "done". */
  devicePoll(): Promise<string>;
  deviceCancel(): Promise<void>;
  /** Present only when the agent offers `_supercharge/setup/auth_start` (not on the desktop shell). */
  authStart?(providerId: string, kind?: AuthKind): Promise<AuthStart>;
  authPoll?(loginId: string): Promise<AuthLogin>;
  authCancel?(loginId: string): Promise<{ cancelled: boolean }>;
}


/** Desktop shell backend. */
export const desktopSetup: SetupApi = {
  status: () => invoke("setup_status"),
  models: (providerId, baseUrl, apiKey, format) => invoke("setup_models", { providerId, baseUrl, apiKey: apiKey ?? null, format }),
  save: ({ sessionId: _s, ...req }) => invoke("setup_save", { req: { ...req, apiKey: req.apiKey ?? null } }),
  deviceStart: () => invoke("setup_device_start"),
  devicePoll: () => invoke("setup_device_poll"),
  deviceCancel: () => invoke("setup_device_cancel"),
};

/** Backend over a JSON-RPC call: `_supercharge/setup/<op>` (agent) or the gateway's `_supercharge/setup`. */
export function rpcSetup(call: (op: string, params: Record<string, unknown>) => Promise<any>, auth = false): SetupApi {
  const api: SetupApi = {
    status: () => call("status", {}).then(normalizeStatus),
    models: (providerId, baseUrl, apiKey, format) => call("models", { providerId, baseUrl, apiKey, format }).then((r) => r?.models ?? r ?? []),
    save: ({ sessionId, ...r }) =>
      call("save", sessionId ? { ...r, sessionId } : r).then((res) => ({ ...normalizeStatus(res), ...(Array.isArray(res?.switchedSessions) ? { switchedSessions: res.switchedSessions } : {}) })),
    deviceStart: () => call("device_start", {}),
    devicePoll: () => call("device_poll", {}).then((r) => (typeof r === "string" ? r : r?.status ?? "pending")),
    deviceCancel: () => call("device_cancel", {}).then(() => {}),
  };
  if (auth) {
    api.authStart = (providerId, kind) => call("auth_start", kind ? { providerId, kind } : { providerId });
    api.authPoll = (loginId) => call("auth_poll", { loginId });
    api.authCancel = (loginId) => call("auth_cancel", { loginId }).then((r) => ({ cancelled: !!r?.cancelled }));
  }
  return api;
}

type ExtClient = { hasExtension(m: string): boolean; ext<T = any>(m: string, p?: unknown): Promise<T> };
/** The connected agent's `_supercharge/setup/*` over ACP, or null when it does not offer them. */
export function agentSetup(client?: ExtClient | null): SetupApi | null {
  return client?.hasExtension("_supercharge/setup/save") ? rpcSetup((op, p) => client.ext(`_supercharge/setup/${op}`, p), client.hasExtension("_supercharge/setup/auth_start")) : null;
}
/** Prefer the agent's own setup over ACP when it offers one, else the desktop shell. */
export function pickSetup(client?: ExtClient | null): SetupApi | null {
  return agentSetup(client) ?? (isDesktop() ? desktopSetup : null);
}

/**
 * List a Studio provider's models through the CLI (`_supercharge/setup/models`), not by HTTP from
 * the app. No key is sent: the CLI uses its own saved key or login for that provider/base URL.
 */
export function listProviderModels(api: SetupApi, p: Pick<Provider, "baseUrl" | "format" | "cli">, catalog: SetupProvider[] = []): Promise<SetupModel[]> {
  const base = p.baseUrl.trim();
  const id = p.cli?.split("|")[0] || catalog.find((c) => normBase(c.baseUrl) === normBase(base))?.id || CUSTOM.id;
  return api.models(id, base, undefined, asFmt(p.format));
}

/** `_supercharge/setup/auth_changed` listeners (the agent's notification when a login finishes). */
const authListeners = new Set<(l: AuthLogin) => void>();
export function onAuthChanged(cb: (l: AuthLogin) => void) { authListeners.add(cb); return () => void authListeners.delete(cb); }
export function emitAuthChanged(l: unknown) { if ((l as AuthLogin)?.loginId) for (const cb of [...authListeners]) cb(l as AuthLogin); }

/**
 * Wait for a CLI sign-in: poll every `interval` (raised when the CLI raises it), finish early on
 * `auth_changed`, give up after `expiresIn`. Resolves on `done`; rejects with the CLI's message otherwise.
 */
export async function waitAuth(api: Pick<SetupApi, "authPoll">, s: Pick<AuthStart, "loginId" | "interval" | "expiresIn">, cancelled: () => boolean, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<AuthLogin> {
  let every = Math.max(s.interval, 1) * 1000, off = () => {};
  const end = Date.now() + Math.max(s.expiresIn, 30) * 1000;
  const pushed = new Promise<AuthLogin>((res) => { off = onAuthChanged((l) => l.loginId === s.loginId && l.status !== "pending" && res(l)); });
  try {
    for (;;) {
      let l = await Promise.race([wait(every).then(() => null), pushed]);
      if (cancelled()) throw new Error("cancelled");
      if (!l && Date.now() > end) throw new Error("Sign-in expired");
      l ??= await api.authPoll!(s.loginId);
      if (l.status === "done") return l;
      if (l.status !== "pending") throw new Error(l.message || `Sign-in ${l.status}`);
      every = Math.max(every, l.interval * 1000);
    }
  } finally { off(); }
}

/**
 * Sign in through the CLI: `auth_start` + wait (or `device_*` on CLIs without `auth_start`).
 * `shown` gets the link (and code) to show and open; `resume` waits on a login already running.
 */
export async function cliSignIn(api: SetupApi, providerId: string, h: { cancelled: () => boolean; shown: (d: DeviceStart, loginId?: string) => void; resume?: AuthLogin; wait?: (ms: number) => Promise<unknown> }): Promise<void> {
  if (api.authStart && api.authPoll) {
    const s: AuthStart = h.resume ? { ...h.resume, url: "", expiresIn: 900 } : await api.authStart(providerId);
    if (h.cancelled()) throw new Error("cancelled");
    h.shown({ userCode: s.userCode ?? "", verificationUri: s.url, expiresIn: s.expiresIn, interval: s.interval }, s.loginId);
    await waitAuth(api, s, h.cancelled, h.wait as any);
    return;
  }
  const d = await api.deviceStart();
  if (h.cancelled()) throw new Error("cancelled");
  h.shown(d);
  await pollDevice(api, d.interval, d.expiresIn, h.cancelled, h.wait as any);
}

/** Poll a device login until approved, honoring the interval and slow_down. Resolves when done. */
export async function pollDevice(api: SetupApi, interval: number, expiresIn: number, cancelled: () => boolean, wait?: (ms: number) => Promise<unknown>): Promise<void> {
  // The older `device_*` steps on the same waiter: slow_down adds a second.
  let iv = Math.min(Math.max(interval, 1), 5);
  await waitAuth({ authPoll: async () => { const r = await api.devicePoll(); if (r === "slow_down") iv++; return { status: r === "done" ? r : "pending", interval: iv } as AuthLogin; } }, { loginId: "", interval: iv, expiresIn }, cancelled, wait as any);
}

// ---- Model saves (picker fallback and typed ids) ----
export const asFmt = (f?: string | null): Fmt =>
  f === "messages" || f === "responses" || f === "chat_completions" ? f : f === "anthropic" ? "messages" : "chat_completions";
const withCur = (opts: { value: string; name?: string }[], cur?: string | null) =>
  cur && !opts.some((o) => o.value === cur) ? [{ value: cur, name: cur }, ...opts] : opts;

export async function setupModel(api: SetupApi): Promise<ModelOpt | undefined> {
  const st: any = await api.status().catch(() => null);
  const cur: string | undefined = st?.model ?? st?.modelId ?? undefined;
  const pid = st?.providerId ?? "", base = st?.baseUrl ?? "", fmt = asFmt(st?.format);
  const list = pid || base ? await api.models(pid, base, undefined, fmt).catch(() => []) : [];
  if (!cur && !list.length) return undefined;
  return { id: "model", name: "Model", currentValue: cur, options: withCur((list as any[]).map((m) => ({ value: m.id, name: m.name || m.id })), cur), source: "setup", setup: { providerId: pid, baseUrl: base, format: fmt } };
}

export function saveSetupModel(api: SetupApi, opt: ModelOpt, value: string, sessionId?: string) {
  const s = (opt as any).setup ?? {};
  const name = opt.options?.find((o) => o.value === value)?.name;
  return api.save({ providerId: s.providerId, baseUrl: s.baseUrl, format: s.format, modelId: value, modelName: name && name !== value ? name : undefined, sessionId });
}

export async function saveCustomModel(api: SetupApi, modelId: string, extra: { modelName?: string; sessionId?: string; baseUrl?: string; format?: Fmt; providerId?: string; apiKey?: string } = {}) {
  const st: any = await api.status().catch(() => null);
  const name = extra.modelName?.trim();
  return api.save({
    providerId: extra.providerId || st?.providerId || "custom",
    baseUrl: extra.baseUrl ?? st?.baseUrl ?? "",
    format: asFmt(extra.format ?? st?.format),
    modelId,
    modelName: name && name !== modelId ? name : undefined,
    sessionId: extra.sessionId,
    ...(extra.apiKey !== undefined ? { apiKey: extra.apiKey } : {}),
  });
}

// ---- CLI provider import ----
/**
 * The provider the Supercharge CLI is configured with, as a Studio provider reference.
 * Only ids, base URL, format and model ids are read; the API key never leaves the CLI.
 * Null when nothing is configured or the CLI has no setup methods (older CLIs).
 */
export async function readCli(api: SetupApi, list?: () => Promise<any>): Promise<Provider | null> {
  const s: any = await api.status().catch(() => null);
  const pid: string = s?.providerId || "", known = providerCatalog(s).find((p) => p.id === pid);
  const base: string = s?.baseUrl || known?.baseUrl || "";
  if (s?.configured === false || !(pid || base)) return null;
  const format = asFmt(s.format ?? known?.format);
  const got: any = await (list?.() ?? Promise.reject()).catch(() => api.models(pid, base, undefined, format)).catch(() => []);
  const cur: string | undefined = s.model ?? s.modelId;
  const ids = [...new Set([cur, ...(got?.models ?? got ?? []).map((m: any) => m?.id)].filter(Boolean))] as string[];
  const cli = `${pid || "custom"}|${normBase(base)}`;
  let host = base;
  try { host = new URL(normBase(base)).host; } catch { /* keep the URL */ }
  return { id: `cli-${cli.replace(/[^a-z0-9]+/gi, "-")}`, name: known?.name ?? host, baseUrl: base, format, models: ids.slice(0, 200), cli };
}

/**
 * Add or refresh the imported provider. Null when nothing changes: removed by the user,
 * edited in Studio, or the same endpoint already set up by hand (no duplicates).
 */
export function mergeCli(list: Provider[], imp: Provider, removed: string[] = []): Provider[] | null {
  if (!imp.cli || removed.includes(imp.cli)) return null;
  const old = list.find((p) => p.cli === imp.cli);
  if (!old) return list.some((p) => !p.cli && normBase(p.baseUrl) === normBase(imp.baseUrl)) ? null : [...list, imp];
  const next = { ...imp, id: old.id };
  return old.edited || JSON.stringify(next) === JSON.stringify(old) ? null : list.map((p) => (p === old ? next : p));
}

/** Point the CLI at an imported provider: no `apiKey`, so the CLI keeps using its own saved key. */
export const applyCli = (api: SetupApi, p: Provider, sessionId?: string) =>
  api.save({ providerId: p.cli!.split("|")[0], baseUrl: p.baseUrl, format: asFmt(p.format), modelId: p.models[0] ?? "", sessionId });
