import { describe, expect, it } from "vitest";
import { contextFromUsageNotification, isResponseCompleted, responseCompletedKey, usedFromResponseCompleted } from "../src/lib/contextUsage";
import { LegacyNotificationDedup } from "../src/acp/legacyNames";
import { legacyName } from "../src/acp/legacyNames";

describe("context usage", () => {
  it("parses _supercharge/session/context_usage", () => {
    expect(contextFromUsageNotification("_supercharge/session/context_usage", { sessionId: "s1", usedTokens: 52300, maxTokens: 200000 })).toEqual({
      sessionId: "s1",
      used: 52300,
      max: 200000,
    });
    expect(contextFromUsageNotification("_supercharge/session_notification", { sessionId: "s1", usedTokens: 1, maxTokens: 2 })).toBeNull();
    expect(contextFromUsageNotification("_supercharge/session/context_usage", { sessionId: "s1", usedTokens: 10, maxTokens: 0 })).toBeNull();
  });

  it("derives used tokens from snake_case response_completed usage", () => {
    expect(usedFromResponseCompleted({ input_tokens: 52000, output_tokens: 300, cache_read_input_tokens: 0 })).toBe(52300);
    expect(usedFromResponseCompleted({ input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 })).toBe(160);
  });

  it("keys response_completed by message_id so dual frames share one ledger entry", () => {
    const u = { sessionUpdate: "response_completed", message_id: "m9", usage: { input_tokens: 1, output_tokens: 2 } };
    expect(responseCompletedKey("s1", u)).toBe("s1:rc:m9");
    expect(responseCompletedKey("s1", u)).toBe(responseCompletedKey("s1", { ...u }));
    expect(isResponseCompleted("_supercharge/session_notification", { sessionId: "s1", update: u })).toBe(true);
    expect(isResponseCompleted("_supercharge/session/context_usage", { sessionId: "s1" })).toBe(false);
  });

  it("LegacyNotificationDedup drops the legacy copy of dual-emitted response_completed", () => {
    const d = new LegacyNotificationDedup();
    const params = { sessionId: "s1", update: { sessionUpdate: "response_completed", message_id: "m1", usage: { input_tokens: 10, output_tokens: 1 } } };
    expect(d.accept("_supercharge/session_notification", params)).toBe(true);
    expect(d.accept(legacyName("session_notification"), params)).toBe(false);
  });
});
