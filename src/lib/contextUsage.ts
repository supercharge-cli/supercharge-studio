/**
 * Context window and response_completed helpers for ACP notifications.
 *
 * Prefer `_supercharge/session/context_usage` { sessionId, usedTokens, maxTokens }.
 * Fall back to deriving used tokens from `response_completed` usage (snake_case).
 * Dual-emitted response_completed frames are deduped by AcpClient; callers still
 * key ledger writes by message_id so a stray duplicate cannot double-count.
 */

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : Number(v));

/** Agent-reported context fill after a model call. */
export function contextFromUsageNotification(method: string, params: any): { sessionId: string; used: number; max: number } | null {
  if (method !== "_supercharge/session/context_usage" || !params?.sessionId) return null;
  const used = num(params.usedTokens);
  const max = num(params.maxTokens);
  if (!(used >= 0) || !(max > 0)) return null;
  return { sessionId: String(params.sessionId), used, max };
}

/** Derive used tokens from response_completed usage (input + cache reads + output). */
export function usedFromResponseCompleted(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  const input = num(usage.input_tokens ?? usage.inputTokens) || 0;
  const cached = num(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cachedReadTokens) || 0;
  const output = num(usage.output_tokens ?? usage.outputTokens) || 0;
  return input + cached + output;
}

/** Stable ledger key so dual-emitted response_completed cannot double-count. */
export function responseCompletedKey(sessionId: string, update: any): string {
  const mid = update?.message_id ?? update?.messageId;
  if (mid != null && mid !== "") return `${sessionId}:rc:${mid}`;
  const u = update?.usage ?? {};
  return `${sessionId}:rc:${u.input_tokens ?? u.inputTokens ?? 0}:${u.output_tokens ?? u.outputTokens ?? 0}:${u.cache_read_input_tokens ?? 0}:${u.reasoning_tokens ?? 0}`;
}

export function isResponseCompleted(method: string, params: any): boolean {
  return method === "_supercharge/session_notification" && params?.update?.sessionUpdate === "response_completed";
}
