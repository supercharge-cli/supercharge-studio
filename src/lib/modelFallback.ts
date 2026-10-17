/**
 * The composer's model picker must not depend on the agent advertising a `model` config option.
 * After a /setup-style save the agent may only know one configured model and advertise no
 * `model` option (or one with no choices), which used to hide the picker. Fall back to the
 * session's ACP model state, then to the configured provider's model list.
 */
import type { ConfigOption } from "../acp/types";
import type { SetupApi, Fmt } from "./setup";

export type ModelSource = "option" | "session" | "setup";
export type ModelOpt = ConfigOption & { source?: ModelSource };

/** The agent's own model option, kept even when it lists no choices but names the current model. */
export function agentModel(options: ConfigOption[] | undefined): ModelOpt | undefined {
  const o = options?.find((x) => x.id === "model");
  return o && (o.options?.length || o.currentValue) ? { ...o, options: withCurrent(o.options ?? [], o.currentValue), source: "option" } : undefined;
}

const withCurrent = (opts: { value: string; name?: string }[], cur?: string | null) => (cur && !opts.some((o) => o.value === cur) ? [{ value: cur, name: cur }, ...opts] : opts);

/** ACP session model state: `{ currentModelId, availableModels: [{ modelId, name }] }`. */
export function sessionModel(models: any): ModelOpt | undefined {
  const list = Array.isArray(models?.availableModels) ? models.availableModels : [];
  const cur = typeof models?.currentModelId === "string" ? models.currentModelId : undefined;
  if (!list.length && !cur) return undefined;
  return { id: "model", name: "Model", currentValue: cur, options: withCurrent(list.filter((m: any) => typeof m?.modelId === "string").map((m: any) => ({ value: m.modelId, name: m.name || m.modelId })), cur), source: "session" };
}

const FMTS = ["chat_completions", "messages", "responses"];
/** The configured provider's models (agent `_supercharge/setup/*`, desktop shell, or phone gateway). */
export async function setupModel(api: SetupApi): Promise<ModelOpt | undefined> {
  const st: any = await api.status().catch(() => null);
  const cur: string | undefined = st?.model ?? st?.modelId ?? undefined;
  const pid = st?.providerId ?? "", base = st?.baseUrl ?? "";
  const fmt = (FMTS.includes(st?.format) ? st.format : st?.format === "anthropic" ? "messages" : "chat_completions") as Fmt;
  const list = pid || base ? await api.models(pid, base, undefined, fmt).catch(() => []) : [];
  if (!cur && !list.length) return undefined;
  return { id: "model", name: "Model", currentValue: cur, options: withCurrent((list as any[]).map((m) => ({ value: m.id, name: m.name || m.id })), cur), source: "setup", setup: { providerId: pid, baseUrl: base, format: fmt } };
}

/** Save a fallback pick through provider setup (keeps the saved key). */
export function saveSetupModel(api: SetupApi, opt: ModelOpt, value: string) {
  const s = (opt as any).setup ?? {};
  const name = opt.options?.find((o) => o.value === value)?.name;
  return api.save({ providerId: s.providerId, baseUrl: s.baseUrl, format: s.format, modelId: value, modelName: name && name !== value ? name : undefined });
}
