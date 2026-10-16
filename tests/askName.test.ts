import { describe, expect, it } from "vitest";
import { branchError, worktreeNameError } from "../src/lib/askName";
describe("name validation", () => {
  it("branch names", () => {
    expect(branchError("feature/x")).toBeNull();
    for (const bad of ["", "a b", "-x", "x/", "a..b", "x.lock", "a~b", "a:b", "a//b"]) expect(branchError(bad)).not.toBeNull();
  });
  it("worktree names", () => {
    expect(worktreeNameError("Fix it")).toBeNull();
    expect(worktreeNameError("  ")).not.toBeNull();
    expect(worktreeNameError("!!!")).not.toBeNull();
  });
});
