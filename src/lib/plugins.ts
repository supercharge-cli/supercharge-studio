/** Target-bound plugin management. Never persist request bodies containing credentials. */
export type PluginRpc = (method: string, params?: Record<string, unknown>) => Promise<any>;
export type Plugin = { id: string; name: string; description?: string; version?: string; enabled: boolean; trusted: boolean; skillNames: string[]; mcpServerCount: number };
export type CatalogPlugin = { name: string; version: string; description: string; endpoint: string; authentication: string; source: string };
export type Account = { id: string; plugin: string; server: string; origin: string; account: string; secretKind?: string; secretBackend?: string; active: boolean };
export function unwrapPluginResult(value: any): any {
  if (value?.error) throw new Error(typeof value.error === "string" ? value.error : value.error.message ?? "Agent operation failed");
  const result = value && Object.hasOwn(value, "result") ? value.result : value;
  if (result?.status && !["success", "pending", "authenticated", "cancelled"].includes(result.status)) throw new Error(result.message ?? "Agent operation failed");
  return result;
}
export function pluginTarget(bind: string, stdio: boolean): { label: string; secure: boolean } {
  if (stdio) return { label: "Local agent · stdio", secure: true };
  try {
    const u = new URL(bind.includes("://") ? bind : `ws://${bind}`);
    return { label: `${u.protocol}//${u.host}${u.pathname}`, secure: u.protocol === "wss:" || (u.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) };
  } catch { return { label: "Invalid agent address", secure: false }; }
}
