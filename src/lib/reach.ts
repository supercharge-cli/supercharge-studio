/** Local / Public connection mode for the mobile gateway (see docs/RELAY.md). */
export const DEFAULT_RELAY = "wss://relay.superchargeai.in";
export type Reach = "local" | "public";
export type ReachPrefs = { reach?: Reach; relayUrl?: string; hostId?: string };

/** Older installs had no `reach`: a configured relay URL meant "public". New installs default to public. */
export const reachOf = (p: ReachPrefs): Reach => p.reach ?? (p.relayUrl === undefined ? "public" : p.relayUrl.trim() ? "public" : "local");

/** The relay to connect to, or undefined in Local mode. A custom relay URL overrides the built-in one. */
export const effectiveRelay = (p: ReachPrefs): string | undefined => {
  if (reachOf(p) !== "public") return undefined;
  const u = p.relayUrl?.trim();
  return u && /^wss?:\/\//.test(u) ? u.replace(/\/+$/, "") : DEFAULT_RELAY;
};

export const newHostId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Prefs with a relay host id guaranteed when Public is on (the relay binds it on first use). */
export const ensureHostId = <T extends ReachPrefs>(p: T): T => (reachOf(p) === "public" && !p.hostId ? { ...p, hostId: newHostId() } : p);

/** Device-facing connect URL on the relay for this computer, or undefined in Local mode. */
export const relayConnect = (p: ReachPrefs): string | undefined => {
  const r = effectiveRelay(p);
  return r && p.hostId ? `${r}/v1/connect/${p.hostId}` : undefined;
};

/** Firewall prompts and checks only apply to Local mode on a LAN-bound gateway; Public mode only connects outward. */
export const needsFirewall = (p: ReachPrefs & { mode?: string }): boolean => reachOf(p) === "local" && p.mode === "lan";
