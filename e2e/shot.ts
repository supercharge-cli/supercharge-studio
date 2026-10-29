import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Where e2e specs save reference screenshots: $SCS_SHOT_DIR, else test-results/shots (git-ignored).
 * The directory is created on first use, so a fresh CI runner works.
 */
export function shotPath(name: string): string {
  const dir = resolve(process.env.SCS_SHOT_DIR || "test-results/shots");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}
