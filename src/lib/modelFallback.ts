import type { ConfigOption } from "../acp/types";

export type ModelSource = "option" | "session" | "setup" | "custom";
export type ModelOpt = ConfigOption & { source?: ModelSource };
export type CustomModel = { id: string; name?: string };

const withCurrent = (opts: { value: string; name?: string }[], cur?: string | null) => (cur && !opts.some((o) => o.value === cur) ? [{ value: cur, name: cur }, ...opts] : opts);

export function agentModel(options: ConfigOption[] | undefined): ModelOpt | undefined {
  const o = options?.find((x) => x.id === "model");
  return o && (o.options?.length || o.currentValue) ? { ...o, options: withCurrent(o.options ?? [], o.currentValue), source: "option" } : undefined;
}

export function mergeCustom(opts: { value: string; name?: string }[], custom: CustomModel[] | undefined, cur?: string | null) {
  const seen = new Set(opts.map((o) => o.value));
  const extra = (custom ?? []).filter((c) => c.id && !seen.has(c.id)).map((c) => ({ value: c.id, name: c.name || c.id }));
  return withCurrent([...opts, ...extra], cur);
}

export function rememberCustom(list: CustomModel[] | undefined, id: string, name?: string): CustomModel[] {
  const n = name?.trim() && name.trim() !== id ? name.trim() : undefined;
  return [{ id, ...(n ? { name: n } : {}) }, ...(list ?? []).filter((c) => c.id !== id)].slice(0, 40);
}

export function sessionModel(models: any): ModelOpt | undefined {
  const list = Array.isArray(models?.availableModels) ? models.availableModels : [];
  const cur = typeof models?.currentModelId === "string" ? models.currentModelId : undefined;
  if (!list.length && !cur) return undefined;
  return { id: "model", name: "Model", currentValue: cur, options: withCurrent(list.filter((m: any) => typeof m?.modelId === "string").map((m: any) => ({ value: m.modelId, name: m.name || m.modelId })), cur), source: "session" };
}
