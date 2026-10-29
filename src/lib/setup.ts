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
export type SetupProvider = { id: string; name: string; description: string; baseUrl: string; defaultModel: string; format: Fmt; keyOptional?: boolean; device?: boolean };
const P = (id: string, name: string, description: string, baseUrl: string, defaultModel: string, format: Fmt = "chat_completions", x: Partial<SetupProvider> = {}): SetupProvider => ({ id, name, description, baseUrl, defaultModel, format, ...x });

/** Built-in providers, in the CLI's order. */
export const PROVIDERS: SetupProvider[] = [
  P("pollinations", "Pollinations", "Recommended — large free/cheap model list", "https://gen.pollinations.ai/v1", "openai"),
  P("openai", "OpenAI", "api.openai.com", "https://api.openai.com/v1", "gpt-5.4"),
  P("anthropic", "Anthropic", "Claude via the Anthropic Messages API", "https://api.anthropic.com/v1", "claude-sonnet-4-6", "messages"),
  P("openrouter", "OpenRouter", "Pay-per-use multi-provider aggregator", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4-6"),
  P("deepseek", "DeepSeek", "V4 / chat / reasoner", "https://api.deepseek.com/v1", "deepseek-chat"),
  P("google", "Google AI Studio", "Gemini via OpenAI-compatible endpoint", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-pro"),
  P("groq", "Groq", "Fast Llama inference", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
  P("zai", "Z.AI / GLM", "Zhipu GLM direct API", "https://api.z.ai/api/paas/v4", "glm-5.1"),
  P("kimi-coding", "Kimi Coding", "Moonshot OpenAI-compatible", "https://api.moonshot.ai/v1", "kimi-k2.6"),
  P("kimi", "Moonshot (Kimi Anthropic)", "Kimi via Anthropic-compatible endpoint", "https://api.moonshot.ai/anthropic", "kimi-k2.6", "messages"),
  P("qwen", "Qwen Cloud", "DashScope OpenAI-compatible", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen3.6-plus"),
  P("mistral", "Mistral AI", "Mistral / Codestral", "https://api.mistral.ai/v1", "mistral-large-latest"),
  P("together", "Together AI", "Open models inference", "https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo"),
  P("fireworks", "Fireworks AI", "OpenAI-compatible hosted models", "https://api.fireworks.ai/inference/v1", "accounts/fireworks/models/llama-v3p3-70b-instruct"),
  P("grok", "xAI (Grok)", "Grok direct API", "https://api.x.ai/v1", "grok-4-0709"),
  P("routingrun", "Routing.run", "Open-source model routing", "https://api.routing.run/v1", "route/glm-5.1"),
  P("zenllm", "ZenLLM", "200+ model aggregator", "https://api.zenllm.org/v1", "zhipu/glm-5.1"),
  P("nous", "Nous Research", "Nous Portal OAuth — free-tier models", "https://inference-api.nousresearch.com/v1", "Hermes-4.3-36B", "chat_completions", { device: true }),
  P("ollama", "Ollama (local)", "Local OpenAI-compatible server, key optional", "http://127.0.0.1:11434/v1", "llama3.3", "chat_completions", { keyOptional: true }),
  P("lmstudio", "LM Studio", "Local desktop server, key optional", "http://127.0.0.1:1234/v1", "local-model", "chat_completions", { keyOptional: true }),
];
export const CUSTOM: SetupProvider = P("custom", "Custom / paste a base URL", "", "", "", "chat_completions", { keyOptional: true });

export const FORMATS: [Fmt, string, string][] = [["chat_completions", "Chat Completions", "/chat/completions"], ["messages", "Messages", "/messages"], ["responses", "Responses", "/responses"]];

/** Type-to-filter, as in the CLI: id, name or description; Custom matches "custom", "openai", "base url". */
export function filterProviders(query: string): SetupProvider[] {
  const q = query.trim().toLowerCase();
  const rows = PROVIDERS.filter((p) => !q || p.id.includes(q) || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
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

export type SetupStatus = { providerId?: string | null; baseUrl?: string | null; format?: string | null; model?: string | null; hasKey: boolean; nousSignedIn: boolean };
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

export interface SetupApi {
  status(): Promise<SetupStatus>;
  models(providerId: string, baseUrl: string, apiKey: string | undefined, format: Fmt): Promise<SetupModel[]>;
  save(r: SaveReq): Promise<SaveResult>;
  deviceStart(): Promise<DeviceStart>;
  /** One token check: "pending" | "slow_down" | "done". */
  devicePoll(): Promise<string>;
  deviceCancel(): Promise<void>;
}

export const SETUP_OPS = ["status", "models", "save", "device_start", "device_poll", "device_cancel"] as const;

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
export function rpcSetup(call: (op: string, params: Record<string, unknown>) => Promise<any>): SetupApi {
  return {
    status: () => call("status", {}),
    models: (providerId, baseUrl, apiKey, format) => call("models", { providerId, baseUrl, apiKey, format }).then((r) => r?.models ?? r ?? []),
    save: ({ sessionId, ...r }) => call("save", sessionId ? { ...r, sessionId } : r),
    deviceStart: () => call("device_start", {}),
    devicePoll: () => call("device_poll", {}).then((r) => (typeof r === "string" ? r : r?.status ?? "pending")),
    deviceCancel: () => call("device_cancel", {}).then(() => {}),
  };
}

type ExtClient = { hasExtension(m: string): boolean; ext<T = any>(m: string, p?: unknown): Promise<T> };
/** Prefer the agent's own setup over ACP when it offers one, else the desktop shell. */
export function pickSetup(client?: ExtClient | null): SetupApi | null {
  if (client?.hasExtension("_supercharge/setup/save")) return rpcSetup((op, p) => client.ext(`_supercharge/setup/${op}`, p));
  return isDesktop() ? desktopSetup : null;
}

/** Poll a device login until approved, honoring the interval and slow_down. Resolves when done. */
export async function pollDevice(api: SetupApi, interval: number, expiresIn: number, cancelled: () => boolean, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  let every = Math.min(Math.max(interval, 1), 5) * 1000;
  const end = Date.now() + Math.max(expiresIn, 30) * 1000;
  for (;;) {
    await wait(every);
    if (cancelled()) throw new Error("cancelled");
    if (Date.now() > end) throw new Error("Timed out waiting for Nous Portal approval");
    const r = await api.devicePoll();
    if (r === "done") return;
    if (r === "slow_down") every += 1000;
  }
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
  const pid: string = s?.providerId || "", known = PROVIDERS.find((p) => p.id === pid);
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
