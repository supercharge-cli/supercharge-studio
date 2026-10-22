import { describe, expect, it } from "vitest";
import { chatMentions, transcript } from "../src/lib/transcript";

describe("chat mentions and transcripts", () => {
  it("finds @chat mentions once each", () => expect(chatMentions("see @chat:ab12 and @chat:cd-3, @chat:ab12 x@chat:no")).toEqual(["ab12", "cd-3"]));
  it("renders user and agent turns, newest kept", () => {
    const items: any[] = [{ kind: "user", text: "hi" }, { kind: "tool", toolCallId: "t" }, { kind: "agent", text: "hello" }];
    expect(transcript(items)).toBe("**You:** hi\n\n**Agent:** hello");
    expect(transcript(items, 8)).toBe("…** hello");
  });
});
