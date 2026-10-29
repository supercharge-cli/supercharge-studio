import { invoke, isDesktop } from "../lib/desktop";

/** The phone's Wi-Fi IPv4 address from the native side, if available (used only for error messages). */
export async function phoneIp(): Promise<string | undefined> {
  try {
    if (!isDesktop()) return undefined;
    return (await invoke<string | null>("local_ipv4")) ?? undefined;
  } catch { return undefined; }
}
