/** Check the public GitHub release. No key is involved; the apps only read the latest tag. */
export const RELEASE_REPO = "supercharge-cli/supercharge-studio";
export const APP_VERSION = "1.0.22";
/** Re-check while the app stays open. */
export const UPDATE_EVERY = 6 * 3600e3;

export type AvailableUpdate = {
  version: string;
  page: string;
  asset?: string;
  assetName?: string;
  /** The release's latest.json (rpm/deb and APK installs must match its sha256). */
  manifest?: string;
  /** How this copy was installed (desktop: appimage, rpm, deb, exe, dmg). */
  format?: string;
};
type Asset = { name: string; browser_download_url: string };

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

// Matches by suffix, so it works with both the old versioned and the new stable asset names.
// Unsigned builds, signatures, SHA256SUMS and latest.json are never offered.
const installable = (all: Asset[]) => all.filter((a) => !/unsigned|\.(txt|sig|json)$|^SHA256SUMS$/.test(a.name));

/** Phone: the arm64 APK, else the universal one. */
export const pickApk = (all: Asset[]) => {
  const list = installable(all);
  return list.find((a) => /android-arm64.*\.apk$/i.test(a.name)) ?? list.find((a) => /android-universal.*\.apk$/i.test(a.name));
};

/** Desktop: the installer matching how this copy was installed (see `host_package`). */
export function pickAsset(all: Asset[], format?: string) {
  const list = installable(all);
  const end = (s: string) => list.find((a) => a.name.endsWith(s));
  if (format === "exe" || format === "msi") return end(format === "msi" ? ".msi" : "-setup.exe") ?? end(".msi");
  if (format === "dmg" || format === "rpm" || format === "deb") return end("." + format);
  return end(".AppImage") ?? end(".deb");
}

export async function checkUpdate(current: string, pick: (all: Asset[]) => Asset | undefined, format?: string): Promise<AvailableUpdate | null> {
  const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const body = await res.json();
  const tag = String(body.tag_name ?? "");
  if (!isNewer(tag, current)) return null;
  const all: Asset[] = body.assets ?? [];
  const asset = pick(all);
  const manifest = all.find((a) => a.name === "latest.json")?.browser_download_url;
  return { version: tag.replace(/^v/, ""), page: String(body.html_url ?? ""), asset: asset?.browser_download_url, assetName: asset?.name, manifest, format };
}
