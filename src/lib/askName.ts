/** In-app name prompt (replaces window.prompt). This module (dialog included) loads on first use. */
import { mountNameDialog } from "../components/NameDialog";
export type AskNameOpts = { title: string; label?: string; initial?: string; placeholder?: string; ok?: string; validate?: (v: string) => string | null };

export function askName(o: AskNameOpts): Promise<string | null> {
  return new Promise<string | null>((resolve) => mountNameDialog(o, resolve));
}

/** Git branch-name rules (subset of check-ref-format) → error text, or null when fine. */
export function branchError(v: string): string | null {
  const s = v.trim();
  if (!s) return "Enter a name";
  if (/\s/.test(s)) return "No spaces";
  if (s.startsWith("-") || s.startsWith("/") || s.endsWith("/") || s.endsWith(".") || s.endsWith(".lock")) return "Can't start with - or /, or end with /, . or .lock";
  if (s.includes("..") || s.includes("//") || s.includes("@{") || /[~^:?*[\\\x00-\x1f\x7f]/.test(s)) return "Not allowed: .. // @{ ~ ^ : ? * [ \\";
  return null;
}
/** Worktree name: anything that slugifies to at least one letter or digit. */
export const worktreeNameError = (v: string): string | null => (!v.trim() ? "Enter a name" : !/[a-z0-9]/i.test(v) ? "Use at least one letter or digit" : v.length > 60 ? "Keep it under 60 characters" : null);
