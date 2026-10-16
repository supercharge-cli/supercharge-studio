import type { ConfigOption } from "../acp/types";

/** Context-window override: ACP config option `context_window`, else the `_supercharge/session/context_window` extension. */
export const CONTEXT_WINDOW_OPTION = "context_window";
export const CONTEXT_WINDOW_EXT = "_supercharge/session/context_window";
export const WINDOW_CHOICES: { value: string; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "128000", label: "128K" },
  { value: "200000", label: "200K" },
  { value: "256000", label: "256K" },
  { value: "400000", label: "400K" },
  { value: "1000000", label: "1M" },
  { value: "2000000", label: "2M" },
];

export const windowOption = (options: ConfigOption[] | undefined) => options?.find((o) => o.id === CONTEXT_WINDOW_OPTION);

/** "1m", "400k", "400000", "1.5M" → tokens; "auto"/"" → "auto"; invalid → null. */
export function parseWindow(input: string): number | "auto" | null {
  const s = input.trim().toLowerCase().replace(/[,_\s]/g, "");
  if (!s || s === "auto" || s === "reset") return "auto";
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s);
  if (!m) return null;
  const n = Math.round(parseFloat(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1));
  return n >= 1000 && n <= 100_000_000 ? n : null;
}

export function windowLabel(v: string | number | undefined | null): string {
  if (v == null || v === "" || v === "auto") return "Auto";
  const n = Number(v);
  if (!(n > 0)) return String(v);
  const hit = WINDOW_CHOICES.find((c) => Number(c.value) === n);
  if (hit) return hit.label;
  return n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${+(n / 1e3).toFixed(1)}K`;
}

export type WindowClient = {
  setConfigOption: (sid: string, id: string, value: string) => Promise<any>;
  ext: (method: string, params?: unknown) => Promise<any>;
};

/** Apply a window choice; returns new configOptions when the agent sent them. */
export async function applyWindow(c: WindowClient, sid: string, value: number | "auto", viaOption: boolean): Promise<{ configOptions?: ConfigOption[]; contextWindow?: number | null }> {
  if (viaOption) {
    const r = await c.setConfigOption(sid, CONTEXT_WINDOW_OPTION, String(value));
    return { configOptions: Array.isArray(r?.configOptions) ? r.configOptions : undefined };
  }
  const r = await c.ext(CONTEXT_WINDOW_EXT, { sessionId: sid, contextWindow: value === "auto" ? "auto" : value });
  return { contextWindow: typeof r?.contextWindow === "number" ? r.contextWindow : null };
}
