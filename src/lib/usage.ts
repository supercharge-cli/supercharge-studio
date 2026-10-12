/**
 * Local token-usage ledger and cost estimates.
 *
 * Sources (all optional, ACP-compatible):
 *  - `usage` on a `session/prompt` result (`inputTokens`, `outputTokens`, `cachedReadTokens`, ...)
 *  - extension session notifications (`_<ns>/session/update`) whose update is
 *    `{ sessionUpdate: "turn_completed", usage: { ..., modelUsage: { [model]: {...} } } }`
 *  - `usage_update` session updates carrying the same fields
 * Records are stored in localStorage only.
 */
export type TokenCounts = { input: number; output: number; cached: number; cacheWrite: number; reasoning: number };
export type UsageRecord = TokenCounts & { ts: number; model: string; provider: string; sessionId?: string; calls?: number };
/** USD per 1M tokens. */
export type Price = { input: number; output: number; cached?: number };
export type Pricing = Record<string, Price>;
export type Period = "day" | "month" | "year";

const KEY = "supercharge-studio/usage/v1";
const PKEY = "supercharge-studio/pricing/v1";
const MAX = 20000;

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);

/** Normalize one usage object (any common field naming) to counts. */
export function toCounts(u: any): TokenCounts {
  return {
    input: num(u?.inputTokens ?? u?.input_tokens ?? u?.promptTokens ?? u?.prompt_tokens),
    output: num(u?.outputTokens ?? u?.output_tokens ?? u?.completionTokens ?? u?.completion_tokens),
    cached: num(u?.cachedReadTokens ?? u?.cachedInputTokens ?? u?.cached_tokens ?? u?.cacheReadTokens ?? u?.cache_read_input_tokens),
    cacheWrite: num(u?.cacheCreationTokens ?? u?.cacheWriteTokens ?? u?.cache_creation_input_tokens),
    reasoning: num(u?.reasoningTokens ?? u?.thoughtTokens ?? u?.reasoning_tokens),
  };
}

/** Split a usage payload into per-model records (falls back to `fallbackModel`). */
export function recordsFromUsage(usage: any, ctx: { model?: string; provider?: string; sessionId?: string; ts?: number }): UsageRecord[] {
  if (!usage || typeof usage !== "object") return [];
  const ts = ctx.ts ?? Date.now();
  const provider = ctx.provider ?? "agent";
  const per = usage.modelUsage && typeof usage.modelUsage === "object" ? Object.entries<any>(usage.modelUsage) : [];
  const rows = per.length > 0 ? per : [[ctx.model ?? usage.model ?? "unknown", usage] as [string, any]];
  return rows
    .map(([model, u]) => ({ ts, model, provider, sessionId: ctx.sessionId, calls: num(u?.modelCalls) || undefined, ...toCounts(u) }))
    .filter((r) => r.input + r.output + r.cached + r.reasoning + r.cacheWrite > 0);
}

/** Extract usage from an ACP notification, if it carries any. */
export function usageFromNotification(method: string, params: any): { sessionId: string; usage: any } | null {
  const u = params?.update ?? params;
  if (!u?.usage) return null;
  const isTurn = u.sessionUpdate === "turn_completed" || u.sessionUpdate === "usage_update";
  if (!isTurn || !(method === "session/update" || /^_.+\/session\/update$/.test(method))) return null;
  return { sessionId: String(params?.sessionId ?? ""), usage: u.usage };
}

export function loadUsage(): UsageRecord[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}
export function appendUsage(rs: UsageRecord[]): UsageRecord[] {
  const all = [...loadUsage(), ...rs].slice(-MAX);
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}
export const clearUsage = () => localStorage.removeItem(KEY);

export function loadPricing(): Pricing {
  try {
    return JSON.parse(localStorage.getItem(PKEY) ?? "{}");
  } catch {
    return {};
  }
}
export const savePricing = (p: Pricing) => localStorage.setItem(PKEY, JSON.stringify(p));

/** Estimated USD cost of one record (cached input billed at `cached` price when set). */
export function cost(r: TokenCounts & { model: string }, pricing: Pricing): number {
  const p = pricing[r.model];
  if (!p) return 0;
  const cached = Math.min(r.cached, r.input);
  const fresh = r.input - (p.cached != null ? cached : 0);
  return (fresh * p.input + (p.cached != null ? cached * p.cached : 0) + r.output * p.output) / 1e6;
}

export const bucketKey = (ts: number, period: Period) => {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  if (period === "year") return `${y}`;
  if (period === "month") return `${y}-${m}`;
  return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Consecutive bucket keys ending at `now` (e.g. last 30 days, 12 months, 5 years). */
export function bucketRange(period: Period, n: number, now = Date.now()): string[] {
  const out: string[] = [];
  const d = new Date(now);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), period === "day" ? d.getMonth() : period === "month" ? d.getMonth() - i : 0, period === "day" ? d.getDate() - i : 1);
    if (period === "year") x.setFullYear(d.getFullYear() - i);
    out.push(bucketKey(x.getTime(), period));
  }
  return out;
}

export type Agg = TokenCounts & { cost: number; calls: number };
const zero = (): Agg => ({ input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, cost: 0, calls: 0 });
function add(a: Agg, r: UsageRecord, pricing: Pricing) {
  a.input += r.input;
  a.output += r.output;
  a.cached += r.cached;
  a.cacheWrite += r.cacheWrite;
  a.reasoning += r.reasoning;
  a.calls += r.calls ?? 1;
  a.cost += cost(r, pricing);
}

export function aggregate(rs: UsageRecord[], pricing: Pricing, period: Period, keys: string[]) {
  const buckets = new Map(keys.map((k) => [k, zero()]));
  const byModel = new Map<string, Agg>();
  const byProvider = new Map<string, Agg>();
  const total = zero();
  for (const r of rs) {
    const b = buckets.get(bucketKey(r.ts, period));
    if (!b) continue;
    add(b, r, pricing);
    add(total, r, pricing);
    if (!byModel.has(r.model)) byModel.set(r.model, zero());
    add(byModel.get(r.model)!, r, pricing);
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, zero());
    add(byProvider.get(r.provider)!, r, pricing);
  }
  return { buckets: keys.map((k) => ({ key: k, ...buckets.get(k)! })), byModel: [...byModel], byProvider: [...byProvider], total };
}

export const fmtTokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const fmtUsd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
