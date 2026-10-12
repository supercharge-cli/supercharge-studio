/** Thin wrappers over the desktop shell. All no-ops / rejects in plain web mode. */
export const isDesktop = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error(`Desktop shell required for ${cmd}`);
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const ev = await import("@tauri-apps/api/event");
  return ev.listen<T>(event, (e) => cb(e.payload));
}

/** Attach to a running `supercharge agent serve` or start one. */
export async function ensureAgent(bind: string, secret: string, alwaysApprove: boolean): Promise<"attached" | "started" | "web"> {
  if (!isDesktop()) return "web";
  return invoke("agent_start", { bind, secret, alwaysApprove });
}

/** Environment overrides from the desktop shell (empty in web mode). */
export async function appConfig(): Promise<{ bind?: string | null; secret?: string | null }> {
  if (!isDesktop()) return {};
  return invoke<{ bind?: string | null; secret?: string | null }>("app_config").catch(() => ({}));
}

/** URL of the app's local MCP server exposing the side browser (desktop only). */
export async function mcpUrl(): Promise<string | null> {
  if (!isDesktop()) return null;
  for (let i = 0; i < 20; i++) {
    const u = await invoke<string | null>("mcp_info").catch(() => null);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const KEY_ACCOUNT = "agent-server-key";
/** OS keychain (desktop). Returns undefined when unavailable. */
export async function keychainGet(): Promise<string | null | undefined> {
  if (!isDesktop()) return undefined;
  return invoke<string | null>("secret_get", { account: KEY_ACCOUNT }).catch(() => undefined);
}
export async function keychainSet(value: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return invoke("secret_set", { account: KEY_ACCOUNT, value }).then(() => true, () => false);
}

export type ProviderDef = { id: string; name: string; baseUrl: string; format: string; models: string[] };
export const providerSetKey = (id: string, key: string) => invoke<string>("provider_set_key", { id, key });
export const providerSeedFromEnv = (id: string) => invoke<ProviderDef | null>("provider_seed_from_env", { id }).catch(() => null);
export const providerApply = (provider: ProviderDef) => invoke<string[]>("provider_apply", { provider });
export const agentRestart = (bind: string, secret: string, alwaysApprove: boolean) =>
  invoke<string>("agent_restart", { bind, secret, alwaysApprove });

// ---- Mobile gateway (see src-tauri/src/gateway.rs) ----
export type GwDevice = { id: string; name: string; paired_at: number; last_seen: number };
export type GwStatus = { running: boolean; url?: string | null; devices: GwDevice[]; connected: string[]; relay?: string };
export type GwPairing = { uri: string; svg: string; expiresAt: number; pairingId: string };
export const gateway = {
  status: () => invoke<GwStatus>("gateway_status"),
  start: (bind?: string) => invoke<string>("gateway_start", { bind }),
  stop: () => invoke<void>("gateway_stop"),
  pairBegin: (publicUrl?: string, desktopName?: string, relayUrl?: string) => invoke<GwPairing>("gateway_pair_begin", { publicUrl, desktopName, relayUrl }),
  pairAnswer: (pairingId: string, allow: boolean) => invoke<void>("gateway_pair_answer", { pairingId, allow }),
  revoke: (deviceId: string) => invoke<void>("gateway_revoke", { deviceId }),
  relaySet: (relayUrl?: string, hostId?: string) => invoke<void>("gateway_relay_set", { relayUrl, hostId }),
  send: (deviceId: string, msg: unknown) => invoke<boolean>("gateway_send", { deviceId, msg }).catch(() => false),
};

// ---- Managed agent (see src-tauri/src/agent.rs) ----
export type AgentInfo = { bin: string | null; managed: boolean; log: string };
export const agentInfo = () => invoke<AgentInfo>("agent_info");
export const agentLog = () => invoke<string>("agent_log");
export const agentInstall = () => invoke<string>("agent_install");
export const agentProbe = (addr: string) => (isDesktop() ? invoke<boolean>("agent_probe", { addr }) : Promise.resolve(false));
