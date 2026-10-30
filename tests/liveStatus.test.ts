import { describe, expect, it } from "vitest";
import { approvalText, liveText } from "../src/lib/liveStatus";

describe("liveText", () => {
  it("names thinking, writing and finished tools", () => {
    const tools = new Map();
    expect(liveText({ sessionUpdate: "agent_thought_chunk" }, tools)).toBe("Thinking…");
    expect(liveText({ sessionUpdate: "agent_message_chunk" }, tools)).toBe("Writing the reply…");
    expect(liveText({ sessionUpdate: "usage_update" }, tools)).toBeUndefined();
    expect(liveText({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bun test", kind: "execute", status: "in_progress" }, tools)).toBe("Running: bun test");
    expect(liveText({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }, tools)).toBe("Working…");
    expect(tools.size).toBe(0);
  });

  it("shows the file being edited, remembered across updates", () => {
    const tools = new Map();
    expect(liveText({ sessionUpdate: "tool_call", toolCallId: "e", title: "Edit", kind: "edit", status: "pending" }, tools)).toBe("Editing file");
    expect(liveText({ sessionUpdate: "tool_call_update", toolCallId: "e", locations: [{ path: "/repo/src/app.ts" }] }, tools)).toBe("Editing app.ts");
    expect(liveText({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "in_progress" }, tools)).toBe("Editing app.ts");
    expect(liveText({ sessionUpdate: "tool_call", toolCallId: "d", kind: "edit", content: [{ type: "diff", path: "C:\\w\\x.rs" }] }, tools)).toBe("Editing x.rs");
  });

  it("clips long tool titles and approvals", () => {
    const t = liveText({ sessionUpdate: "tool_call", toolCallId: "x", title: "a".repeat(200) }, new Map())!;
    expect(t.length).toBeLessThanOrEqual(70);
    expect(approvalText("rm -rf build")).toBe("Waiting for approval: rm -rf build");
    expect(approvalText()).toBe("Waiting for approval: a tool call");
  });
});
