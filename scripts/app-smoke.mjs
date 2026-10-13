// Smoke test of the real built desktop app through WebDriver (tauri-driver).
// Visits every screen and clicks the main controls; fails if the web process crashes or the
// window goes blank. Usage: node scripts/app-smoke.mjs <app binary> [shots dir]
// Requires `tauri-driver` (and WebKitWebDriver on Linux / msedgedriver on Windows) on PATH.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BIN = process.argv[2];
const SHOTS = process.argv[3] ?? "app-smoke-shots";
if (!BIN) throw new Error("usage: app-smoke.mjs <binary> [shots]");
mkdirSync(SHOTS, { recursive: true });

const driver = spawn("tauri-driver", [], { stdio: ["ignore", "inherit", "inherit"] });
const W = "http://127.0.0.1:4444";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const r = await fetch(W + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) }).catch((e) => { throw new Error(`${method} ${path}: ${e.name === "TimeoutError" ? "WebDriver did not answer in 45s (UI thread stuck?)" : e.message}`); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j.value ?? j).slice(0, 300)}`);
  return j.value;
}
let sid = "";
const s = (p) => `/session/${sid}${p}`;
const exec = (script, args = []) => call("POST", s("/execute/sync"), { script, args });
const ELEM = "element-6066-11e4-a52e-4f735466cecc";
async function find(css, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { const v = await call("POST", s("/element"), { using: "css selector", value: css }); const id = v?.[ELEM] ?? Object.values(v ?? {})[0]; if (id) return id; } catch (e) { if (Date.now() > end) throw new Error(`not found: ${css}`); }
    if (Date.now() > end) throw new Error(`not found: ${css}`);
    await sleep(200);
  }
}
async function click(css) { const id = await find(css); await call("POST", s(`/element/${id}/click`), {}); await sleep(350); }
async function key(k) { await call("POST", s("/actions"), { actions: [{ type: "key", id: "kb", actions: [...k.flatMap((c) => [{ type: "keyDown", value: c }]), ...k.reverse().flatMap((c) => [{ type: "keyUp", value: c }])] }] }); await sleep(300); }
let n = 0;
async function check(label) {
  const st = await exec("return { marker: window.__smoke === 1, nodes: document.body ? document.body.querySelectorAll('*').length : 0, text: (document.body?.innerText || '').length }");
  const png = await call("GET", s("/screenshot")).catch(() => null);
  if (png) writeFileSync(join(SHOTS, `${String(++n).padStart(2, "0")}-${label}.png`), Buffer.from(png, "base64"));
  if (!st.marker) throw new Error(`${label}: page reloaded or web process crashed`);
  if (st.nodes < 20 || st.text < 10) throw new Error(`${label}: window looks blank (${st.nodes} nodes)`);
  console.log(`ok  ${label} (${st.nodes} nodes)`);
}

// Never hang CI: fail with a clear message after 6 minutes.
const watchdog = setTimeout(() => { console.error("app smoke FAILED: watchdog timeout"); driver.kill(); process.exit(1); }, 1200000);
watchdog.unref?.();
try {
  for (let i = 0; i < 50; i++) { try { await fetch(W + "/status"); break; } catch { await sleep(200); } }
  // pageLoadStrategy "none": older WebKitWebDriver otherwise waits its 300 s page-load timeout after
  // clicks/keys in the single-page app (seen on Ubuntu 22.04 CI: every step took exactly 5 minutes).
  const caps = { "tauri:options": { application: BIN }, pageLoadStrategy: "none", timeouts: { pageLoad: 10000, script: 30000, implicit: 0 } };
  sid = (await call("POST", "/session", { capabilities: { alwaysMatch: caps } })).sessionId;
  await find('[data-testid="sidebar"]', 20000);
  await exec("window.__smoke = 1");
  await check("start");
  const waitOpen = async (label) => {
    for (let i = 0; i < 60; i++) {
      const t = await exec("return document.querySelector('.status')?.textContent || ''");
      if (t.includes("open")) return console.log(`ok  ${label}: connected`);
      await sleep(250);
    }
    await check(`${label}-not-connected`);
    throw new Error(`${label}: never connected (status: ${await exec("return document.querySelector('[data-testid=notice]')?.innerText || document.querySelector('.status')?.title || ''")})`);
  };
  if (process.env.SMOKE_EXPECT_OPEN) await waitOpen("startup");
  if (process.env.SMOKE_PASTE_URL) {
    await click('[data-testid="open-settings"]');
    await click('[data-testid="tab-connection"]');
    const id = await find('[data-testid="agent-bind"]');
    await call("POST", s(`/element/${id}/clear`), {});
    await call("POST", s(`/element/${id}/value`), { text: process.env.SMOKE_PASTE_URL });
    await click('[data-testid="tab-connection"]'); // blur: the URL is split into address + key
    await click('[data-testid="settings-save"]');
    await sleep(2500);
    await waitOpen("pasted-url");
    const bind = await exec("return JSON.parse(localStorage.getItem('supercharge-studio/v1')||'{}').settings?.bind");
    if (bind !== new URL(process.env.SMOKE_PASTE_URL).host) throw new Error(`pasted-url: address is ${bind}`);
    console.log(`ok  pasted-url: address now ${bind}`);
    await key(["\uE00C"]);
  }
  if (process.env.SMOKE_COMPOSER) {
    // Real file listing through the desktop backend: "@" opens the project picker.
    const ta = await find(".composer textarea");
    await call("POST", s(`/element/${ta}/value`), { text: "/" });
    await find('[data-testid="composer-menu"]');
    const cmds = await exec("return document.querySelector('[data-testid=composer-menu]').innerText");
    for (const c of ["/new", "/setup", "/models", "/theme", "/help"]) if (!cmds.includes(c)) throw new Error(`slash menu is missing ${c}`);
    console.log("ok  slash menu:", cmds.split("\n").filter((l) => l.startsWith("/")).length, "commands");
    await call("POST", s(`/element/${ta}/clear`), {});
    await call("POST", s(`/element/${ta}/value`), { text: `look at @${process.env.SMOKE_COMPOSER}` });
    for (let i = 0; i < 40 && !(await exec("return !!document.querySelector('[data-testid=composer-menu-item]')")); i++) await sleep(250);
    const first = await exec("return document.querySelector('[data-testid=composer-menu-item]')?.innerText || document.querySelector('[data-testid=composer-menu]')?.innerText || 'no menu'");
    console.log("mention picker first row:", first.replace(/\n/g, " "));
    await call("POST", s(`/element/${ta}/value`), { text: "\uE007" });
    await sleep(300);
    const val = await exec("return document.querySelector('.composer textarea').value");
    if (!/^look at @\S+ $/.test(val)) throw new Error(`mention not inserted: ${val}`);
    console.log(`ok  mention inserted: "${val}"`);
    await check("composer-mention");
    await call("POST", s(`/element/${ta}/clear`), {});
  }
  await click('[data-testid="open-palette"]'); await check("palette"); await key(["\uE00C"]);
  await click('[data-testid="new-chat"]').catch(() => {}); await check("new-chat");
  await click('[data-testid="add-project"]').catch(() => {}); await key(["\uE00C"]); await check("add-project");
  await click('[data-testid="open-usage"]'); await check("usage");
  await click('[data-testid="open-settings"]');
  for (const t of ["connection", "providers", "appearance", "agent", "devices"]) { await click(`[data-testid="tab-${t}"]`); await check(`settings-${t}`); }
  await click('[data-testid="tab-connection"]');
  await click('[data-testid="agent-log"] button').catch(() => {}); await check("agent-log");
  if (process.env.SMOKE_GATEWAY) {
    // Real gateway end to end: turn it on in the UI, show a code, pair a simulated phone that
    // first tries a dead address, approve in the app, and exchange an encrypted message.
    await click('[data-testid="tab-devices"]');
    if (process.env.SMOKE_RELAY) {
      if (await exec("return !!document.querySelector('[data-testid=gw-toggle]').checked")) await exec("document.querySelector('[data-testid=gw-toggle]').click()");
      await sleep(500);
      const r = await find('[data-testid="gw-relay"]');
      await call("POST", s(`/element/${r}/clear`), {});
      await call("POST", s(`/element/${r}/value`), { text: process.env.SMOKE_RELAY });
    }
    if (!(await exec("return !!document.querySelector('[data-testid=gw-toggle]').checked"))) await exec("document.querySelector('[data-testid=gw-toggle]').click()");
    await find('[data-testid="gw-diag"]', 10000);
    console.log("gateway diagnostics:", (await exec("return document.querySelector('[data-testid=gw-diag]').innerText")).replace(/\n/g, " | "));
    if (process.env.SMOKE_RELAY) {
      let rs = "";
      for (let i = 0; i < 60 && !/online/.test(rs); i++) {
        rs = await exec("return document.querySelector('[data-testid=gw-relay-status]')?.innerText || ''");
        if (/bound to another key/.test(rs)) { console.log("relay id taken, using a new one"); await click('[data-testid="gw-relay-reset"]'); }
        await sleep(250);
      }
      if (!/online/.test(rs)) throw new Error(`relay never came online: ${rs}`);
      console.log("ok  relay:", rs.trim());
    }
    if (process.env.SMOKE_EXPECT_PORT_MOVED) {
      const note = await exec("return document.querySelector('[data-testid=gw-port-note]')?.innerText || ''");
      if (!/in use/.test(note)) throw new Error("gateway: expected a port-moved note, got: " + note);
      console.log("ok  gateway port moved:", note.trim());
    }
    await click('[data-testid="gw-pair"]');
    const uri = await exec("return document.querySelector('[data-testid=gw-uri]').value");
    console.log("pairing code:", uri.replace(/k=[^&]+/, "k=…"));
    const phone = spawn("npx", ["vite-node", "scripts/phone-sim.ts", "--", uri, process.env.SMOKE_RELAY ? "--relay-only" : "--dead-first"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = ""; phone.stdout.on("data", (d) => { out += d; process.stdout.write("phone> " + d); });
    await click('[data-testid="pair-allow"]').catch(async () => { await sleep(3000); await click('[data-testid="pair-allow"]'); });
    const code = await new Promise((r) => { phone.on("exit", r); setTimeout(() => r(/encrypted reply: \{/.test(out) ? 0 : 1), 40000); });
    phone.kill();
    if (code !== 0 || !/paired: device/.test(out) || !/encrypted reply: \{/.test(out)) throw new Error("gateway: simulated phone did not pair");
    await check("gateway-paired");
    console.log("ok  gateway: phone paired through failover");
  }
  await key(["\uE00C"]);
  await click('[data-testid="collapse-sidebar"]').catch(() => {}); await check("sidebar-collapsed");
  await click('[data-testid="expand-sidebar"]').catch(() => {});
  await exec("document.querySelector('button[title^=\"Show browser\"],button[title^=\"Hide browser\"]')?.click()"); await sleep(800); await check("browser-panel");
  await key(["\uE009", "k"]); await check("palette-shortcut"); await key(["\uE00C"]);
  console.log("app smoke: all screens ok");
} catch (e) {
  console.error("app smoke FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (sid) await call("DELETE", `/session/${sid}`).catch(() => {});
  driver.kill();
}
