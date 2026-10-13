// Live first-run check: CLI absent -> full-screen setup -> verified install -> agent starts.
//   SUPERCHARGE_BIN_DIR=<empty dir> PATH=<without the CLI> node scripts/live-onboard.mjs <app binary>
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BIN = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), "scs-onboard-"));
const env = { ...process.env, XDG_DATA_HOME: join(profile, "d"), XDG_CONFIG_HOME: join(profile, "c"), XDG_CACHE_HOME: join(profile, "k") };
const driver = spawn("tauri-driver", [], { stdio: ["ignore", "ignore", "inherit"], env });
const W = "http://127.0.0.1:4444";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const r = await fetch(W + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j.value ?? j).slice(0, 300)}`);
  return j.value;
}
let sid = "";
const s = (p) => `/session/${sid}${p}`;
const exec = (script, args = []) => call("POST", s("/execute/sync"), { script, args });
const q = (sel) => exec(`return document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
const wait = async (sel, ms) => { const end = Date.now() + ms; for (;;) { const v = await q(sel).catch(() => null); if (v !== null) return v; if (Date.now() > end) throw new Error("timeout waiting " + sel); await sleep(500); } };
let ok = true;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(W + "/status"); break; } catch { await sleep(200); } }
  sid = (await call("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: BIN }, pageLoadStrategy: "none" } } })).sessionId;
  console.log("[setup] screen:", (await wait("[data-testid=cli-setup]", 60000)).split("\n").slice(0, 3).join(" | "));
  await exec("document.querySelector('[data-testid=cli-install]').click();return true");
  await wait("[data-testid=cli-continue]", 300000).catch(async (e) => { console.log("[log]", await q("[data-testid=cli-log]"), await q("[data-testid=cli-error]")); throw e; });
  console.log("[log]\n" + (await q("[data-testid=cli-log]")));
  const png = await call("GET", s("/screenshot")).catch(() => null);
  if (png) writeFileSync("/tmp/live-onboard.png", Buffer.from(png, "base64"));
  await exec("document.querySelector('[data-testid=cli-continue]').click();return true");
  for (let i = 0; ; i++) { const st = await q(".status"); if (st === "open") break; if (i > 120) throw new Error("agent not connected: " + st); await sleep(500); }
  console.log("[agent] connected; setup gone:", (await q("[data-testid=cli-setup]")) === null);
} catch (e) { ok = false; console.error("live onboard FAILED:", e.message); }
finally { if (sid) await call("DELETE", s("")).catch(() => {}); driver.kill(); console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1); }
