/** Desktop git commands (see src-tauri/src/git.rs). */
import { invoke as desk, isDesktop } from "./desktop";
/** e2e hook: the browser build can route git calls to a test double. */
const invoke = <T,>(cmd: string, args: Record<string, unknown>): Promise<T> => { const t = (globalThis as any).__SC_TEST_GIT; return !isDesktop() && t ? Promise.resolve(t(cmd, args)) : desk<T>(cmd, args); };
export const gitAvailable = () => isDesktop() || !!(globalThis as any).__SC_TEST_GIT;
export type GitFile = { path: string; x: string; y: string };
export type GitStatus = { repo: boolean; branch?: string | null; upstream?: string | null; ahead: number; behind: number; files: GitFile[]; root?: string | null };
export type Worktree = { path: string; branch: string; base: string; root: string };
export const git = {
  status: (root: string) => invoke<GitStatus>("git_status", { root }),
  diffFile: (root: string, path: string) => invoke<string>("git_diff_file", { root, path }),
  diffAll: (root: string, max?: number) => invoke<string>("git_diff_all", { root, max }),
  revertHunk: (root: string, patch: string) => invoke<void>("git_revert_hunk", { root, patch }),
  restoreFile: (root: string, path: string) => invoke<void>("git_restore_file", { root, path }),
  stage: (root: string, paths: string[], stage: boolean) => invoke<void>("git_stage", { root, paths, stage }),
  commit: (root: string, message: string, all: boolean) => invoke<string>("git_commit", { root, message, all }),
  branches: (root: string) => invoke<string[]>("git_branches", { root }),
  checkout: (root: string, branch: string, create: boolean) => invoke<void>("git_checkout", { root, branch, create }),
  push: (root: string) => invoke<string>("git_push", { root }),
  openPr: (root: string) => invoke<string>("git_open_pr", { root }),
  worktreeAdd: (root: string, name: string) => invoke<Worktree>("git_worktree_add", { root, name }),
  worktreeMerge: (root: string, path: string, branch: string, base: string) => invoke<string>("git_worktree_merge", { root, path, branch, base }),
  worktreeRemove: (root: string, path: string, branch: string) => invoke<void>("git_worktree_remove", { root, path, branch }),
};
/** Ask the Changes panel to refresh (after a turn, file events…). */
export const refreshChanges = () => window.dispatchEvent(new Event("sc-changes-refresh"));
/** Hook set by App: one-shot commit message from the agent; null when not connected. */
export const commitMessageHook: { ask?: (diff: string) => Promise<string | null> } = {};

/** Distinct file paths a turn edited, from its tool calls' diff content. */
export function editedPaths(toolCalls: any[]): string[] {
  const set = new Set<string>();
  for (const tc of toolCalls) for (const c of tc?.content ?? []) if (c?.type === "diff" && c.path) set.add(String(c.path));
  return [...set];
}
