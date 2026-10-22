import { describe, expect, it } from "vitest";
import { expandPrompt, promptName } from "../src/lib/prompts";

describe("prompt library", () => {
  const ps = [{ name: "review", text: "Review the changes." }, { name: "fix", text: "Fix issue $ARGUMENTS and add a test." }];
  it("expands saved prompts as slash commands", () => {
    expect(expandPrompt(ps, "/review")).toBe("Review the changes.");
    expect(expandPrompt(ps, "/review focus on tests")).toBe("Review the changes.\n\nfocus on tests");
    expect(expandPrompt(ps, "/fix #12")).toBe("Fix issue #12 and add a test.");
    expect(expandPrompt(ps, "/other")).toBeNull();
    expect(expandPrompt(ps, "hello /review")).toBeNull();
    expect(expandPrompt(undefined, "/review")).toBeNull();
  });
  it("normalizes command names", () => expect(promptName(" /My Prompt")).toBe("my-prompt"));
});
