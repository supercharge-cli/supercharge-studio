import type { ConfigOption } from "../acp/types";

export function updateSessionOptions(current: Record<string, ConfigOption[]>, sessionId: string, options: ConfigOption[]): Record<string, ConfigOption[]> {
  return { ...current, [sessionId]: options };
}

export function optionFor(options: ConfigOption[] | undefined, id: "model" | "reasoning_effort"): ConfigOption | undefined {
  const option = options?.find((entry) => entry.id === id);
  return option?.options?.length ? option : undefined;
}
