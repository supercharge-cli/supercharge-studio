import { describe, expect, it } from "vitest";
import { aggregate, bucketKey, bucketRange, cost, recordsFromUsage, toCounts, usageFromNotification } from "../src/lib/usage";

const U = { inputTokens: 39771, outputTokens: 231, totalTokens: 40002, cachedReadTokens: 24903, reasoningTokens: 133, modelCalls: 3, modelUsage: { "gpt-6-luna": { inputTokens: 39771, outputTokens: 231, cachedReadTokens: 24903, reasoningTokens: 133, modelCalls: 3 } } };

describe("usage", () => {
  it("normalizes field names", () => {
    expect(toCounts({ prompt_tokens: 5, completion_tokens: 2, cache_read_input_tokens: 1 })).toEqual({ input: 5, output: 2, cached: 1, cacheWrite: 0, reasoning: 0 });
  });
  it("splits per model", () => {
    const rs = recordsFromUsage(U, { provider: "Test", ts: 1 });
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ model: "gpt-6-luna", provider: "Test", input: 39771, output: 231, cached: 24903, reasoning: 133, calls: 3 });
    expect(recordsFromUsage({ inputTokens: 0 }, {})).toEqual([]);
  });
  it("reads turn reports from extension notifications only", () => {
    expect(usageFromNotification("_vendor/session/update", { sessionId: "s", update: { sessionUpdate: "turn_completed", usage: U } })?.sessionId).toBe("s");
    expect(usageFromNotification("_vendor/other", { update: { sessionUpdate: "turn_completed", usage: U } })).toBeNull();
    expect(usageFromNotification("session/update", { sessionId: "s", update: { sessionUpdate: "agent_message_chunk" } })).toBeNull();
  });
  it("estimates cost with cached pricing", () => {
    const r = { model: "m", input: 1_000_000, output: 1_000_000, cached: 500_000, cacheWrite: 0, reasoning: 0 };
    expect(cost(r, { m: { input: 2, output: 8 } })).toBeCloseTo(10);
    expect(cost(r, { m: { input: 2, output: 8, cached: 0.5 } })).toBeCloseTo(1 + 0.25 + 8);
    expect(cost(r, {})).toBe(0);
  });
  it("buckets by day/month/year", () => {
    const now = new Date(2026, 9, 12, 15).getTime();
    expect(bucketRange("day", 3, now)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(bucketRange("month", 2, now)).toEqual(["2026-09", "2026-10"]);
    expect(bucketRange("year", 2, now)).toEqual(["2025", "2026"]);
    expect(bucketKey(new Date(2026, 0, 1).getTime(), "month")).toBe("2026-01");
    const rs = [...recordsFromUsage(U, { provider: "A", ts: now }), ...recordsFromUsage({ inputTokens: 10, outputTokens: 5 }, { model: "x", provider: "B", ts: now - 86400e3 })];
    const a = aggregate(rs, { "gpt-6-luna": { input: 1, output: 1 } }, "day", bucketRange("day", 7, now));
    expect(a.total.input).toBe(39781);
    expect(a.byProvider.map(([k]) => k).sort()).toEqual(["A", "B"]);
    expect(a.buckets.at(-1)!.output).toBe(231);
    expect(a.buckets.at(-2)!.input).toBe(10);
    expect(a.total.cost).toBeCloseTo((39771 + 231) / 1e6);
  });
});
