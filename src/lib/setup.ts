/**
 * Provider setup, the same as the CLI's `/setup`: the same provider list (names, descriptions,
 * order), the same steps, and a config.toml the CLI reads. Three backends share one shape:
 * the desktop shell (Tauri), an agent that advertises `_supercharge/setup/*` over ACP, and
 * the phone, which asks the paired computer through the gateway.
 */
import { invoke, isDesktop } from "./desktop";

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
/** `apiKey` undefined keeps the saved key (or the Nous login token). */
export type SaveReq = { providerId: string; baseUrl: string; apiKey?: string; format: Fmt; modelId: string; modelName?: string };
export type DeviceStart = { userCode: string; verificationUri: string; expiresIn: number; interval: number };

export interface SetupApi {
  status(): Promise<SetupStatus>;
  models(providerId: string, baseUrl: string, apiKey: string | undefined, format: Fmt): Promise<SetupModel[]>;
  save(r: SaveReq): Promise<SetupStatus>;
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
  save: (req) => invoke("setup_save", { req: { ...req, apiKey: req.apiKey ?? null } }),
  deviceStart: () => invoke("setup_device_start"),
  devicePoll: () => invoke("setup_device_poll"),
  deviceCancel: () => invoke("setup_device_cancel"),
};

/** Backend over a JSON-RPC call: `_supercharge/setup/<op>` (agent) or the gateway's `_supercharge/setup`. */
export function rpcSetup(call: (op: string, params: Record<string, unknown>) => Promise<any>): SetupApi {
  return {
    status: () => call("status", {}),
    models: (providerId, baseUrl, apiKey, format) => call("models", { providerId, baseUrl, apiKey, format }).then((r) => r?.models ?? r ?? []),
    save: (r) => call("save", r),
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
