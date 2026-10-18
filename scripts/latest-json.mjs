/**
 * Writes `latest.json` (the in-app updater manifest) from the signed release assets.
 * Usage: node scripts/latest-json.mjs <dir> <tag> <owner/repo>
 * Skips quietly when there are no signatures (no updater signing key in CI).
 * Served from releases/latest/download/latest.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Release asset -> updater targets (`{os}-{arch}` and `{os}-{arch}-{bundle}`). */
export const TARGETS = {
  "Supercharge-Studio-windows-x64-setup.exe": ["windows-x86_64", "windows-x86_64-nsis"],
  "Supercharge-Studio-windows-x64.msi": ["windows-x86_64-msi"],
  "Supercharge-Studio-macos-universal.app.tar.gz": ["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app", "darwin-x86_64-app"],
  "Supercharge-Studio-linux-x86_64.AppImage": ["linux-x86_64", "linux-x86_64-appimage"],
};

/** `sigs` maps asset name -> contents of its .sig file. */
export function buildLatest(sigs, tag, repo, date = new Date().toISOString()) {
  const platforms = {};
  for (const [name, targets] of Object.entries(TARGETS)) {
    const signature = sigs[name]?.trim();
    if (!signature) continue;
    for (const t of targets) platforms[t] = { signature, url: `https://github.com/${repo}/releases/download/${tag}/${name}` };
  }
  if (!Object.keys(platforms).length) return null;
  return { version: tag.replace(/^v/, ""), notes: `Supercharge Studio ${tag}`, pub_date: date, platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, tag, repo] = process.argv.slice(2);
  if (!dir || !tag || !repo) throw new Error("usage: latest-json.mjs <dir> <tag> <owner/repo>");
  const sigs = {};
  for (const name of Object.keys(TARGETS)) {
    const f = join(dir, `${name}.sig`);
    if (existsSync(f) && existsSync(join(dir, name))) sigs[name] = readFileSync(f, "utf8");
  }
  const latest = buildLatest(sigs, tag, repo);
  if (!latest) {
    console.log("::notice::No updater signatures: skipping latest.json (in-app updates fall back to the download link)");
  } else {
    writeFileSync(join(dir, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
    console.log(`latest.json: ${Object.keys(latest.platforms).join(", ")}`);
  }
}
