import { expect, Page, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A real temp git repo; the browser build's git calls are served by real git here. */
function makeRepo() {
  const d = mkdtempSync(join(tmpdir(), "sc-e2e-git-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(d, "app.ts"), Array.from({ length: 14 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n");
  g("add", "."); g("commit", "-qm", "init");
  const lines = readFileSync(join(d, "app.ts"), "utf8").split("\n");
  lines[0] = 'const v0 = "changed";'; lines[12] = "export const v12 = 120;";
  writeFileSync(join(d, "app.ts"), lines.join("\n"));
  writeFileSync(join(d, "notes.md"), "# New file\n");
  return { d, g };
}

function serve(d: string, g: (...a: string[]) => string) {
  return (cmd: string, a: any): unknown => {
    const run = (args: string[], input?: string) => execFileSync("git", ["-C", d, ...args], { encoding: "utf8", input });
    switch (cmd) {
      case "git_status": {
        const out = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        const files = out.split("\0").filter(Boolean).map((r) => ({ x: r[0] === "?" ? " " : r[0], y: r[1], path: r.slice(3) }));
        return { repo: true, branch: run(["branch", "--show-current"]).trim(), ahead: 1, behind: 0, upstream: "origin/main", files, root: d };
      }
      case "git_diff_file": {
        const tracked = run(["ls-files", "--", a.path]).trim();
        if (tracked) return run(["diff", "--no-color", "HEAD", "--", a.path]);
        try { return run(["diff", "--no-color", "--no-index", "--", "/dev/null", a.path]); } catch (e: any) { return e.stdout; }
      }
      case "git_diff_all": return run(["diff", "--no-color", "HEAD"]);
      case "git_revert_hunk": run(["apply", "-R", "--recount", "-"], a.patch); return null;
      case "git_restore_file": if (run(["ls-files", "--", a.path]).trim()) run(["checkout", "HEAD", "--", a.path]); else run(["clean", "-f", "--", a.path]); return null;
      case "git_stage": run(a.stage ? ["add", "--", ...a.paths] : ["reset", "-q", "HEAD", "--", ...a.paths]); return null;
      case "git_commit": if (a.all) run(["add", "-A"]); run(["commit", "-F", "-"], a.message); return run(["rev-parse", "--short", "HEAD"]).trim();
      case "git_branches": return run(["branch", "--format=%(refname:short)"]).trim().split("\n");
      default: throw new Error(`unsupported in e2e: ${cmd}`);
    }
  };
}

async function boot(page: Page, cwd: string, handler: (c: string, a: any) => unknown) {
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.route(/^https:\/\/api\.github\.com\//, (route) => route.fulfill({ status: 404, body: "{}" }));
  await page.exposeFunction("__scGitNode", (c: string, a: any) => handler(c, a));
  await page.addInitScript((cwd) => {
    (globalThis as any).__SC_TEST_GIT = (c: string, a: unknown) => (window as any).__scGitNode(c, a);
    localStorage.setItem("supercharge-studio/v1", JSON.stringify({ settings: { bind: "127.0.0.1:2421", secret: "e2e", transport: "ws", autoStart: false, alwaysApprove: false }, groups: [{ id: "g1", name: "Personal", projects: [{ id: "p1", name: "demo", cwd, chats: [{ id: "c1", title: "Parallel fix", createdAt: 1, worktree: { path: cwd + "/.supercharge/worktrees/fix", branch: "supercharge/fix", base: "main", root: cwd } }] }] }], activeProjectId: "p1", activeChatId: "c1" }));
  }, cwd);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("open");
}

test("changes panel: diff, hunk reject, file keep/reject, commit (real temp git repo)", async ({ page }) => {
  const { d, g } = makeRepo();
  await boot(page, d, serve(d, g));
  await expect(page.getByTestId("wt-badge")).toContainText("fix");
  await expect(page.getByTestId("wt-bar")).toContainText("Merge into main");
  await page.getByTitle("Show side panel (Ctrl \\)").click();
  await page.getByTestId("changes-tab").click();
  await expect(page.getByTestId("changes-badge")).toHaveText("2");
  await expect(page.getByTestId("change-file")).toHaveCount(2);
  await expect(page.getByTestId("hunk")).toHaveCount(2);
  await expect(page.getByTestId("git-ab")).toHaveText("↑1 ↓0");
  await page.screenshot({ path: "/workspace/out/g-changes-unified.png" });
  await page.getByTestId("diff-mode").click();
  await expect(page.locator(".cd-split").first()).toBeVisible();
  await page.screenshot({ path: "/workspace/out/g-changes-split.png" });
  // Reject the first hunk only: line 1 goes back, line 13 stays changed.
  await page.getByTestId("hunk-reject").first().click();
  await expect(page.getByTestId("hunk")).toHaveCount(1);
  const txt = readFileSync(join(d, "app.ts"), "utf8");
  expect(txt.startsWith("const v0 = 0;")).toBe(true);
  expect(txt).toContain("export const v12 = 120;");
  // Reject the untracked file entirely.
  await page.getByRole("button", { name: "U notes.md" }).click({ timeout: 5000 });
  await expect(page.locator(".diff-head strong")).toHaveText("notes.md", { timeout: 5000 });
  page.once("dialog", (dl) => void dl.accept());
  await page.getByTestId("file-reject").click();
  await expect(page.getByTestId("change-file")).toHaveCount(1);
  expect(existsSync(join(d, "notes.md"))).toBe(false);
  // Generate (local heuristic, no agent) and commit.
  await page.getByTestId("commit-gen").click();
  // Agent connected (fake agent) → its one-shot reply; else the local heuristic "Update app.ts".
  await expect(page.getByTestId("commit-msg")).not.toHaveValue("");
  const msg = (await page.getByTestId("commit-msg").inputValue()).trim();
  await page.screenshot({ path: "/workspace/out/g-commit.png" });
  await page.getByTestId("commit-btn").click();
  await expect(page.getByTestId("git-note")).toContainText("Committed");
  await expect(page.getByTestId("change-file")).toHaveCount(0);
  expect(g("log", "-1", "--format=%s").trim()).toBe(msg.split("\n")[0]);
});

test("a turn that edits files shows 'N files changed — Review' which opens the Changes tab", async ({ page }) => {
  const { d, g } = makeRepo();
  await boot(page, d, serve(d, g));
  await page.getByPlaceholder("Message Supercharge…").fill("please edit the app");
  await page.getByPlaceholder("Message Supercharge…").press("Enter");
  const row = page.getByTestId("turn-changes");
  await expect(row).toContainText("1 file changed");
  await expect(row).toContainText("app.ts");
  await page.screenshot({ path: "/workspace/out/g-turn-review.png" });
  await page.getByTestId("turn-review").click();
  await expect(page.getByTestId("changes-pane")).toBeVisible();
  await expect(page.getByTestId("change-file")).toHaveCount(2);
});
