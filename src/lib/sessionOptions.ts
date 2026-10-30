import type { ConfigOption } from "../acp/types";

export function updateSessionOptions(current: Record<string, ConfigOption[]>, sessionId: string, options: ConfigOption[]): Record<string, ConfigOption[]> {
  return { ...current, [sessionId]: options };
}

export function optionFor(options: ConfigOption[] | undefined, id: "model" | "reasoning_effort" | "permission_mode"): ConfigOption | undefined {
  const option = options?.find((entry) => entry.id === id);
  return option?.options?.length ? option : undefined;
}

/** Display names for reasoning_effort values (CLI may omit `name`). */
const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

/** Map wire aliases so `none` matches `off` for UI comparison only. */
export function normalizeEffort(value: string | undefined): string {
  if (!value) return "";
  return value === "none" ? "off" : value;
}

export function effortLabel(value: string, name?: string): string {
  if (name && name.trim()) return name;
  return EFFORT_LABELS[value] ?? EFFORT_LABELS[normalizeEffort(value)] ?? value;
}

export function sameEffort(a: string | undefined, b: string | undefined): boolean {
  return normalizeEffort(a) === normalizeEffort(b) && !!normalizeEffort(a);
}

/**
 * The agent's thinking-level select: id `reasoning_effort` or category `thought_level`.
 * Adds display names (xhigh → "Extra High") without rewriting wire values, so
 * session/set_config_option still matches the agent's option list.
 */
export function reasoningOption(options: ConfigOption[] | undefined): ConfigOption | undefined {
  const raw = options?.find((o) => (o.id === "reasoning_effort" || o.category === "thought_level") && (o.options?.length ?? 0) > 0);
  if (!raw?.options?.length) return undefined;
  return {
    ...raw,
    id: raw.id || "reasoning_effort",
    options: raw.options.map((c) => ({ ...c, name: effortLabel(c.value, c.name) })),
  };
}

/** Wire value to send so a session matches the level the user last picked, or undefined when nothing should change. */
export function effortToApply(options: ConfigOption[] | undefined, last: string | undefined): string | undefined {
  const r = reasoningOption(options);
  const hit = last ? r?.options?.find((c) => sameEffort(c.value, last)) : undefined;
  return hit && !sameEffort(hit.value, r!.currentValue) ? hit.value : undefined;
}

/**
 * The model the composer shows: the session's own model when the agent lists the last pick (so a chat on another
 * model never looks like it runs the last pick), else the last pick (typed ids saved through setup), else the fallback.
 */
export function shownModel(agent: ConfigOption | undefined, last: string | undefined, fallback: string | undefined): string | undefined {
  const listed = !!last && !!agent?.options?.some((o) => o.value === last);
  return (listed || !last ? agent?.currentValue : undefined) ?? last ?? fallback;
}
