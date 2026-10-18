/**
 * Writes `latest.json` (the in-app updater manifest) for a release directory.
 * Usage: node scripts/latest-json.mjs <dir> <tag> <owner/repo>
 * - `platforms`: signed updater bundles (only when the updater signing key was set in CI).
 * - `packages`: url + sha256 of the rpm, deb and signed APKs. The apps install an rpm/deb/APK
 *   only when its sha256 matches this entry.
 * Served from releases/latest/download/latest.json.
 */
import { createHash } from "node:crypto";
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

/** Packages the apps install themselves (verified against `packages[name].sha256`). */
export const PACKAGES = [
  "supercharge-studio-linux-x86_64.rpm",
  "supercharge-studio-linux-amd64.deb",
  "supercharge-studio-android-arm64.apk",
  "supercharge-studio-android-arm.apk",
  "supercharge-studio-android-x86_64.apk",
  "supercharge-studio-android-universal.apk",
];

/** `sigs` maps asset name -> contents of its .sig file; `shas` maps package name -> sha256 hex. */
export function buildLatest(sigs, tag, repo, date = new Date().toISOString(), shas = {}) {
  const url = (name) => `https://github.com/${repo}/releases/download/${tag}/${name}`;
  const platforms = {};
  const packages = {};
  for (const name of PACKAGES) if (/^[0-9a-f]{64}$/.test(shas[name] ?? "")) packages[name] = { url: url(name), sha256: shas[name] };
  for (const [name, targets] of Object.entries(TARGETS)) {
    const signature = sigs[name]?.trim();
    if (!signature) continue;
    for (const t of targets) platforms[t] = { signature, url: url(name) };
  }
  if (!Object.keys(platforms).length && !Object.keys(packages).length) return null;
  return { version: tag.replace(/^v/, ""), notes: `Supercharge Studio ${tag}`, pub_date: date, platforms, packages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, tag, repo] = process.argv.slice(2);
  if (!dir || !tag || !repo) throw new Error("usage: latest-json.mjs <dir> <tag> <owner/repo>");
  const sigs = {};
  for (const name of Object.keys(TARGETS)) {
    const f = join(dir, `${name}.sig`);
    if (existsSync(f) && existsSync(join(dir, name))) sigs[name] = readFileSync(f, "utf8");
  }
  const shas = {};
  for (const name of PACKAGES) {
    const f = join(dir, name);
    if (existsSync(f)) shas[name] = createHash("sha256").update(readFileSync(f)).digest("hex");
  }
  const latest = buildLatest(sigs, tag, repo, undefined, shas);
  if (!latest) {
    console.log("::notice::Nothing signed and no packages: skipping latest.json");
  } else {
    if (!Object.keys(latest.platforms).length) console.log("::notice::No updater signatures: latest.json lists packages only (signed desktop updates fall back to the download link)");
    writeFileSync(join(dir, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
    console.log(`latest.json platforms: ${Object.keys(latest.platforms).join(", ") || "none"}; packages: ${Object.keys(latest.packages).join(", ") || "none"}`);
  }
}
