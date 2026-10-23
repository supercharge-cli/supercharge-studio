/** Typed-model setup/save (mobile lazy). */
export async function customSave(api: { status: () => Promise<any>; save: (r: any) => Promise<any> }, modelId: string, modelName?: string, sessionId?: string) {
  const st = await api.status().catch(() => null);
  const fmt = st?.format;
  return api.save({ providerId: st?.providerId || "custom", baseUrl: st?.baseUrl ?? "", format: fmt === "messages" || fmt === "responses" ? fmt : "chat_completions", modelId, modelName: modelName && modelName !== modelId ? modelName : undefined, sessionId });
}
