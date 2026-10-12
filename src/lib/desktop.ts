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
