import { describe, expect, it } from "vitest";
import { applyUpdate, emptySession, isBrowserTool } from "../src/acp/session";

describe("session reducer", () => {
  it("merges message chunks and tracks tool calls", () => {
    let s = emptySession();
    s = applyUpdate(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    s = applyUpdate(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    s = applyUpdate(s, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Open page", kind: "fetch", status: "pending" });
    s = applyUpdate(s, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
    s = applyUpdate(s, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
    s = applyUpdate(s, { sessionUpdate: "plan", entries: [{ content: "step", status: "pending" }] });
    expect(s.items).toEqual([{ kind: "agent", text: "Hello" }, { kind: "tool", toolCallId: "t1" }]);
    expect(s.toolCalls.t1.status).toBe("completed");
    expect(s.toolCalls.t1.title).toBe("Open page");
    expect(s.toolCalls.t1.content).toHaveLength(1);
    expect(s.plan).toHaveLength(1);
    expect(isBrowserTool(s.toolCalls.t1)).toBe(true);
  });
  it("creates tool item from update without prior tool_call; ignores unknown", () => {
    let s = applyUpdate(emptySession(), { sessionUpdate: "tool_call_update", toolCallId: "x", status: "failed" });
    s = applyUpdate(s, { sessionUpdate: "something_new", foo: 1 });
    expect(s.items).toHaveLength(1);
    expect(s.toolCalls.x.status).toBe("failed");
  });
});
