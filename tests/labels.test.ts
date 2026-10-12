import { describe, expect, it } from "vitest";
import { cleanPermission, neutralize, personaNames } from "../src/lib/labels";

describe("labels", () => {
  it("learns a persona name and neutralises it", () => {
    const opts = ["Yes, proceed", "No, and tell Zed what to do differently", "Ask Zed later"];
    const names = personaNames(opts);
    expect(names).toEqual(["Zed"]);
    expect(neutralize(opts[1], names)).toBe("No, and tell the agent what to do differently");
    expect(neutralize("Zed will run it. Zed is sure.", names)).toBe("The agent will run it. The agent is sure.");
  });
  it("leaves clean requests untouched", () => {
    const req = { options: [{ name: "Yes, proceed" }], toolCall: { title: "Run ls" } };
    expect(cleanPermission(req)).toBe(req);
  });
  it("cleans options", () => {
    const req = { options: [{ name: "No, and tell Zed what to do differently" }], toolCall: { title: "x" } };
    expect(cleanPermission(req).options[0].name).toBe("No, and tell the agent what to do differently");
  });
});
