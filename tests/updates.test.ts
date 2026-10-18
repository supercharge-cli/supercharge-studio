import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkUpdate, isNewer, pickApk, pickAsset } from "../src/lib/updates";
// @ts-expect-error plain ESM script without types
import { buildLatest, TARGETS } from "../scripts/latest-json.mjs";

const REL = "https://github.com/supercharge-cli/supercharge-studio/releases/download/v1.0.18/";
const names = [
  "Supercharge-Studio-linux-x86_64.AppImage", "Supercharge-Studio-linux-x86_64.AppImage.sig",
  "supercharge-studio-linux-amd64.deb", "supercharge-studio-linux-x86_64.rpm",
  "Supercharge-Studio-macos-universal.dmg", "Supercharge-Studio-macos-universal.app.tar.gz", "Supercharge-Studio-macos-universal.app.tar.gz.sig",
  "Supercharge-Studio-windows-x64.msi", "Supercharge-Studio-windows-x64.msi.sig", "Supercharge-Studio-windows-x64-setup.exe", "Supercharge-Studio-windows-x64-setup.exe.sig",
  "supercharge-studio-android-arm64.apk", "supercharge-studio-android-universal.apk", "supercharge-studio-android-arm64-unsigned.apk",
  "latest.json", "SHA256SUMS", "SRCINFO.txt",
];
const assets = names.map((name) => ({ name, browser_download_url: REL + name }));

describe("release compare", () => {
  it("treats a higher version as newer", () => {
    expect(isNewer("v0.1.7", "0.1.6")).toBe(true);
    expect(isNewer("0.1.7", "0.1.7")).toBe(false);
    expect(isNewer("0.1.5", "0.1.7")).toBe(false);
    expect(isNewer("v1.0.18", "1.0.17")).toBe(true);
    expect(isNewer("1.1.0", "1.0.99")).toBe(true);
  });
});

describe("asset picking", () => {
  it("picks the installer that matches how the app was installed", () => {
    expect(pickAsset(assets, "rpm")?.name).toBe("supercharge-studio-linux-x86_64.rpm");
    expect(pickAsset(assets, "deb")?.name).toBe("supercharge-studio-linux-amd64.deb");
    expect(pickAsset(assets, "appimage")?.name).toBe("Supercharge-Studio-linux-x86_64.AppImage");
    expect(pickAsset(assets, "exe")?.name).toBe("Supercharge-Studio-windows-x64-setup.exe");
    expect(pickAsset(assets, "msi")?.name).toBe("Supercharge-Studio-windows-x64.msi");
    expect(pickAsset(assets, "dmg")?.name).toBe("Supercharge-Studio-macos-universal.dmg");
    expect(pickAsset(assets)?.name).toBe("Supercharge-Studio-linux-x86_64.AppImage");
  });
  it("never offers signatures, manifests, checksums or unsigned builds", () => {
    const junk = ["x.AppImage.sig", "latest.json", "SHA256SUMS", "supercharge-studio-android-arm64-unsigned.apk"].map((name) => ({ name, browser_download_url: name }));
    expect(pickAsset(junk)).toBeUndefined();
    expect(pickApk(junk)).toBeUndefined();
  });
  it("picks the signed arm64 APK on phones, else the universal one", () => {
    expect(pickApk(assets)?.name).toBe("supercharge-studio-android-arm64.apk");
    expect(pickApk(assets.filter((a) => !a.name.includes("arm64")))?.name).toBe("supercharge-studio-android-universal.apk");
  });
});

describe("update check", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (body: unknown, ok = true) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => body })));

  it("returns the newer release with the asset, SHA256SUMS and install format", async () => {
    stub({ tag_name: "v1.0.18", html_url: "https://github.com/supercharge-cli/supercharge-studio/releases/tag/v1.0.18", assets });
    const u = await checkUpdate("1.0.17", (all) => pickAsset(all, "rpm"), "rpm");
    expect(u).toEqual({
      version: "1.0.18",
      page: "https://github.com/supercharge-cli/supercharge-studio/releases/tag/v1.0.18",
      asset: REL + "supercharge-studio-linux-x86_64.rpm",
      assetName: "supercharge-studio-linux-x86_64.rpm",
      sums: REL + "SHA256SUMS",
      format: "rpm",
    });
    expect((fetch as any).mock.calls[0][0]).toBe("https://api.github.com/repos/supercharge-cli/supercharge-studio/releases/latest");
  });
  it("returns nothing when up to date or the request fails", async () => {
    stub({ tag_name: "v1.0.17", assets });
    expect(await checkUpdate("1.0.17", pickApk)).toBeNull();
    stub({}, false);
    expect(await checkUpdate("1.0.17", pickApk)).toBeNull();
  });
});

describe("latest.json", () => {
  const sigs = { "Supercharge-Studio-windows-x64-setup.exe": "SIGEXE\n", "Supercharge-Studio-windows-x64.msi": "SIGMSI", "Supercharge-Studio-macos-universal.app.tar.gz": "SIGMAC", "Supercharge-Studio-linux-x86_64.AppImage": "SIGAPP" };
  it("maps every signed asset to its updater targets with fixed release URLs", () => {
    const l = buildLatest(sigs, "v1.0.18", "supercharge-cli/supercharge-studio", "2026-10-18T00:00:00Z");
    expect(l.version).toBe("1.0.18");
    expect(l.pub_date).toBe("2026-10-18T00:00:00Z");
    expect(l.platforms["windows-x86_64"]).toEqual({ signature: "SIGEXE", url: REL + "Supercharge-Studio-windows-x64-setup.exe" });
    expect(l.platforms["windows-x86_64-nsis"].signature).toBe("SIGEXE");
    expect(l.platforms["windows-x86_64-msi"].url).toBe(REL + "Supercharge-Studio-windows-x64.msi");
    for (const t of ["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app"]) expect(l.platforms[t].url).toBe(REL + "Supercharge-Studio-macos-universal.app.tar.gz");
    expect(l.platforms["linux-x86_64"]).toEqual({ signature: "SIGAPP", url: REL + "Supercharge-Studio-linux-x86_64.AppImage" });
    // Asset names stay versionless (the release check rejects versioned names).
    for (const n of Object.keys(TARGETS)) expect(n).not.toMatch(/\d+\.\d+\.\d+/);
  });
  it("is skipped when nothing is signed", () => {
    expect(buildLatest({}, "v1.0.18", "a/b")).toBeNull();
  });
});

describe("updater config", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  it("checks the fixed latest.json and verifies with the public key", () => {
    expect(conf.plugins.updater.endpoints).toEqual(["https://github.com/supercharge-cli/supercharge-studio/releases/latest/download/latest.json"]);
    expect(atob(conf.plugins.updater.pubkey)).toMatch(/public key/);
    expect(conf.app.security.csp).toContain("https://api.github.com");
  });
  it("builds without the signing secret (updater bundles are opt-in per build)", () => {
    expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
    expect(release).toMatch(/if \[ -n "\$TAURI_SIGNING_PRIVATE_KEY" \]; then\s+npx tauri build \$\{\{ matrix\.args \}\} --config '\{"bundle":\{"createUpdaterArtifacts":true\}\}'/);
    expect(release).toContain('node scripts/latest-json.mjs dist "$TAG"');
  });
});
