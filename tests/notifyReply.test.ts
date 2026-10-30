import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const android = "mobile/src-tauri/gen/android/app/src/main/";

describe("reply from notifications", () => {
  it("desktop tries the Open/Reply alert first and falls back to the plugin", () => {
    const s = read("src/lib/notifyDeliver.ts");
    expect(s.indexOf('"notify_actions"')).toBeGreaterThan(-1);
    expect(s.indexOf('"notify_actions"')).toBeLessThan(s.indexOf("plugin:notification|notify"));
    expect(read("src/App.tsx")).toMatch(/notification-action[\s\S]{0,200}\.composer textarea/);
    for (const f of ["src-tauri/build.rs", "src-tauri/permissions/app.toml"]) expect(read(f)).toContain('"notify_actions"');
  });
  it("the phone page queues a notification reply and marks itself ready", () => {
    const s = read("src/mobile/MobileApp.tsx");
    expect(s).toMatch(/queued\.current\.push\(\{ sid: chat, text: t \}\)[\s\S]*"supercharge:reply", onReply/);
    expect(s).toContain("__scReply = 1");
  });
  it("Android declares the reply receiver and the quick-settings tile", () => {
    const m = read(android + "AndroidManifest.xml");
    expect(m).toContain('android:name=".ReplyReceiver"');
    expect(m).toMatch(/\.StudioTile[\s\S]*BIND_QUICK_SETTINGS_TILE[\s\S]*action\.QS_TILE/);
    const q = read(android + "java/in/superchargeai/studio/mobile/QuickActions.kt");
    expect(q).toContain("FLAG_MUTABLE"); // RemoteInput needs a mutable PendingIntent
    expect(q).toContain("class StudioTile : TileService()");
  });
});
