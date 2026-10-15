/** Check the public GitHub release. No key is involved; the apps only read the latest tag. */
export const RELEASE_REPO = "supercharge-cli/supercharge-studio";
export const APP_VERSION = "1.0.11";

export type AvailableUpdate = {
  version: string;
  page: string;
  asset?: string;
  assetName?: string;
};

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

// Matches by suffix, so it works with both the old versioned and the new stable asset names.
function pickAsset(names: { name: string; browser_download_url: string }[], kind: "desktop" | "mobile", format?: string) {
  const list = names.filter((a) => !a.name.includes("unsigned") && !a.name.endsWith(".txt") && a.name !== "SHA256SUMS");
  if (kind === "mobile") return list.find((a) => /android-arm64.*\.apk$/i.test(a.name)) ?? list.find((a) => /android-universal.*\.apk$/i.test(a.name));
  if (format === "exe") return list.find((a) => a.name.endsWith("-setup.exe")) ?? list.find((a) => a.name.endsWith(".msi"));
  if (format === "dmg") return list.find((a) => a.name.endsWith(".dmg"));
  if (format === "rpm") return list.find((a) => a.name.endsWith(".rpm"));
  if (format === "deb") return list.find((a) => a.name.endsWith(".deb"));
  return list.find((a) => a.name.endsWith(".AppImage")) ?? list.find((a) => a.name.endsWith(".deb"));
}

export async function checkUpdate(current: string, kind: "desktop" | "mobile", format?: string): Promise<AvailableUpdate | null> {
  const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const body = await res.json();
  const tag = String(body.tag_name ?? "");
  if (!isNewer(tag, current)) return null;
  const asset = pickAsset(body.assets ?? [], kind, format);
  return { version: tag.replace(/^v/, ""), page: String(body.html_url ?? ""), asset: asset?.browser_download_url, assetName: asset?.name };
}
