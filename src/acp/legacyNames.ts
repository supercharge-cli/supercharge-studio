/**
 * Compatibility with legacy ACP extension names.
 *
 * The Supercharge CLI renamed its ACP extensions to `_supercharge/<name>`. During the
 * migration it accepts both names, sends every notification twice (the `_supercharge/`
 * frame first, then the legacy one), still sends its own requests under the legacy names,
 * and advertises capability keys under both. Older CLIs (e.g. 1.3.30) only use the legacy
 * names. Every legacy-name string the app knows about lives in this module and nowhere else,
 * so it can be deleted in one place once the legacy names are gone.
 *
 * `_meta` keys are NOT renamed and must not go through this module.
 */

/** Legacy prefixes: methods/notifications use the underscore form, capability keys the bare form. */
const LEGACY_PREFIXES = ["_x.ai/", "x.ai/"] as const;
export const SUPERCHARGE_PREFIX = "_supercharge/";

/** True for a method name or capability key that uses a legacy prefix. */
export function isLegacyName(name: string): boolean {
  return LEGACY_PREFIXES.some((p) => name.startsWith(p));
}

/** Map a legacy method or capability key to its `_supercharge/` name; other names pass through. */
export function canonicalName(name: string): string {
  for (const p of LEGACY_PREFIXES) if (name.startsWith(p)) return SUPERCHARGE_PREFIX + name.slice(p.length);
  return name;
}

/**
 * Drops the legacy copy of a dual-sent notification. A `_supercharge/` notification is
 * remembered (by name and params) until its legacy copy arrives; a legacy notification with
 * no matching remembered frame is from an older CLI and is processed normally.
 */
export class LegacyNotificationDedup {
  private seen = new Map<string, number>();

  /** Returns false when this frame is the legacy duplicate of one already handled. */
  accept(method: string, params: unknown): boolean {
    const legacy = isLegacyName(method);
    if (!legacy && !method.startsWith(SUPERCHARGE_PREFIX)) return true;
    let k = canonicalName(method);
    try { k += JSON.stringify(params ?? null); } catch { /* never matches */ }
    const n = this.seen.get(k) ?? 0;
    if (!legacy) {
      if (this.seen.size > 255) this.seen.clear();
      this.seen.set(k, n + 1);
      return true;
    }
    if (!n) return true;
    n > 1 ? this.seen.set(k, n - 1) : this.seen.delete(k);
    return false;
  }

  reset() {
    this.seen.clear();
  }
}

/** Legacy form of a `_supercharge/` name (`bare` gives the capability-key form). Used by tests. */
export function legacyName(name: string, bare = false): string {
  const n = name.startsWith(SUPERCHARGE_PREFIX) ? name.slice(SUPERCHARGE_PREFIX.length) : name;
  return (bare ? LEGACY_PREFIXES[1] : LEGACY_PREFIXES[0]) + n;
}
