import type { SetupApi, Fmt } from "./setup";
import type { ModelOpt } from "./modelFallback";

const asFmt = (f?: string | null): Fmt =>
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
