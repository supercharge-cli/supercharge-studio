// Live end-to-end check of agent-controlled side browser on a FRESH app profile, with the real
// Supercharge agent and a configured provider. Usage:
//   node scripts/live-browser.mjs <app binary>
// Serves a local page whose secret only appears after a real click, asks the agent to open it
// in the side browser, click the button and report the text. Passes when the page saw the click
// and the agent's reply contains the secret. Requires tauri-driver + WebKitWebDriver.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = process.argv[2];
if (!BIN) throw new Error("usage: live-browser.mjs <binary>");
const secret = "kiwi-" + Math.random().toString(36).slice(2, 8);
let secret2 = "";
const seen = [];
const page = `<!doctype html><title>Live browser check</title><h1>Agent browser check</h1>
<p>Press the button to reveal the code.</p><button id="reveal" onclick="fetch('/clicked');document.getElementById('out').textContent=atob(location.search?'%S2%':'%S1%')">Reveal code</button>
<p id="out">hidden</p>`;
const http = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { "content-type": "text/html" }); res.end(req.url === "/clicked" ? "ok" : page.replace("%S1%", Buffer.from(secret).toString("base64")).replace("%S2%", Buffer.from(secret2 || "x").toString("base64"))); });
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${http.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), "scs-fresh-"));
const env = { ...process.env, XDG_DATA_HOME: join(profile, "data"), XDG_CONFIG_HOME: join(profile, "config"), XDG_CACHE_HOME: join(profile, "cache") };
const driver = spawn("tauri-driver", [], { stdio: ["ignore", "inherit", "inherit"], env });
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
let ok = false;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(W + "/status"); break; } catch { await sleep(200); } }
  sid = (await call("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: BIN }, pageLoadStrategy: "none" } } })).sessionId;
  // Wait for the app to connect to its agent (onboarding may be showing; skip it if so).
  let st = "";
  for (let i = 0; i < 120; i++) {
    st = await exec("const sk=[...document.querySelectorAll('button')].find(b=>/skip|get started|continue/i.test(b.innerText)&&b.closest('.onboarding'));if(sk)sk.click();return (document.querySelector('.status')?.textContent||'')+'|'+!!document.querySelector('.composer textarea')").catch(() => "");
    if (/^open\|true/.test(st)) break;
    await sleep(500);
  }
  console.log("app state:", st);
  async function round(label, secret, url) {
    seen.length = 0;
    const prompt = `Use the side browser tools: open ${url} , click the "Reveal code" button, then tell me exactly the code shown in the paragraph below the button.`;
    await exec("const t=document.querySelector('.composer textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,arguments[0]);t.dispatchEvent(new Event('input',{bubbles:true}));return true", [prompt]);
    await sleep(300);
    await exec("const b=document.querySelector('.composer button[aria-label=Send]')||[...document.querySelectorAll('.composer button')].pop();b.click();return true", []);
    const t0 = Date.now();
    let reply = "";
    while (Date.now() - t0 < 240000) {
      await sleep(2000);
      const r = await exec("return { busy: !!document.querySelector('.composer button[aria-label=Stop]'), reply: [...document.querySelectorAll('.bubble.agent')].map(e=>e.innerText).pop()||'', tools: [...document.querySelectorAll('.toolcard')].map(e=>e.innerText.split('\\n')[0]).slice(-8), sys: [...document.querySelectorAll('.bubble.system')].map(e=>e.innerText).slice(-2) }");
      reply = r.reply;
      if (reply.includes(secret) || (!r.busy && Date.now() - t0 > 15000)) { console.log(`[${label}] tools:`, JSON.stringify(r.tools), r.sys.length ? "system: " + JSON.stringify(r.sys) : ""); break; }
    }
    const png = await call("GET", s("/screenshot")).catch(() => null);
    if (png) writeFileSync(`/tmp/live-browser-${label}.png`, Buffer.from(png, "base64"));
    const pass = seen.includes("/clicked") && reply.includes(secret);
    console.log(`[${label}] page requests: ${JSON.stringify(seen)} | reply: ${reply.slice(0, 160).replace(/\n/g, " ")} | ${pass ? "PASS" : "FAIL"}`);
    return pass;
  }
  // LIVE_CLOSE_PANEL=1: start with the browser panel closed; the agent's first browser call must reopen it.
  if (process.env.LIVE_CLOSE_PANEL === "1") { await exec("document.querySelector('.rpanel .tabs button[title=\"Close panel\"]')?.click();return true"); await sleep(500); console.log("panel open before prompt:", await exec("return !!document.querySelector('.rpanel')")); }
  // Fresh profile: start a chat in the first project (the default workspace or a CLI folder).
  await exec("document.querySelector('[data-testid=new-chat]')?.click();return true");
  await sleep(600);
  ok = await round("first", secret, url);
  console.log("panel open after first round:", await exec("return !!document.querySelector('.rpanel')").catch(() => "?"));
  if (ok && process.env.LIVE_RESTART_AGENT === "1") {
    // Kill the agent mid-session; the app restarts/reconnects it. The browser tools must keep working
    // in the SAME chat without the user reconnecting anything.
    const { execSync } = await import("node:child_process");
    console.log("killing agent:", execSync("pkill -f 'supercharge[ ]agent.*serve' && echo killed || echo none").toString().trim());
    let back = "";
    for (let i = 0; i < 120; i++) { await sleep(500); back = await exec("return document.querySelector('.status')?.textContent||''").catch(() => ""); if (i > 4 && back === "open") break; }
    console.log("after restart, status:", back);
    secret2 = "plum-" + Math.random().toString(36).slice(2, 8);
    ok = await round("after-restart", secret2, url + "?v=2");
  }
  console.log(ok ? "PASS" : "FAIL");
} catch (e) {
  console.error("live browser FAILED:", e.message);
} finally {
  if (sid) await call("DELETE", s("")).catch(() => {});
  driver.kill();
  http.close();
  process.exit(ok ? 0 : 1);
}
