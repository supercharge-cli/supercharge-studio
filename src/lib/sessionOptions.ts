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
