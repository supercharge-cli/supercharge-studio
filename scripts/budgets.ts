/**
 * Size budgets for the shipped web bundles (gzip -9). Run after `npm run build` and
 * `npm run build:mobile`; fails CI when a budget is exceeded.
 */
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const KB = 1024;
const budgets: { dir: string; label: string; entry: RegExp; entryMax: number; totalJsMax: number; cssMax: number }[] = [
  // Includes CLI session sync, browser tools, and per-chat model and permission controls.
  { dir: "dist/assets", label: "desktop", entry: /^index-.*\.js$/, entryMax: 50 * KB, totalJsMax: 59 * KB, cssMax: 10 * KB },
  { dir: "dist-mobile/assets", label: "mobile", entry: /^mobile-.*\.js$/, entryMax: 26 * KB, totalJsMax: 30 * KB, cssMax: 10 * KB },
];
let failed = false;
for (const b of budgets) {
  const files = readdirSync(b.dir).map((f) => ({ f, gz: gzipSync(readFileSync(`${b.dir}/${f}`), { level: 9 }).length }));
  const entry = files.filter((x) => b.entry.test(x.f)).reduce((a, x) => a + x.gz, 0);
  const js = files.filter((x) => x.f.endsWith(".js")).reduce((a, x) => a + x.gz, 0);
  const css = files.filter((x) => x.f.endsWith(".css")).reduce((a, x) => a + x.gz, 0);
  const row = (n: string, v: number, max: number) => {
    const ok = v <= max;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} ${b.label.padEnd(8)} ${n.padEnd(9)} ${(v / KB).toFixed(1).padStart(6)} KB gz (budget ${(max / KB).toFixed(0)} KB)`);
  };
  row("entry js", entry, b.entryMax);
  row("all js", js, b.totalJsMax);
  row("css", css, b.cssMax);
}
if (failed) process.exit(1);
