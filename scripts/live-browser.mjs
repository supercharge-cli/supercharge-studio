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
const seen = [];
const page = `<!doctype html><title>Live browser check</title><h1>Agent browser check</h1>
<p>Press the button to reveal the code.</p><button id="reveal" onclick="fetch('/clicked');document.getElementById('out').textContent=atob('${Buffer.from(secret).toString("base64")}')">Reveal code</button>
<p id="out">hidden</p>`;
const http = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { "content-type": "text/html" }); res.end(req.url === "/clicked" ? "ok" : page); });
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
  const prompt = `Use the side browser tools: open ${url} , click the "Reveal code" button, then tell me exactly the code shown in the paragraph below the button.`;
  // LIVE_CLOSE_PANEL=1: start with the browser panel closed; the agent's first browser call must reopen it.
  if (process.env.LIVE_CLOSE_PANEL === "1") { await exec("document.querySelector('.rpanel .tabs button[title=\"Close panel\"]')?.click();return true"); await sleep(500); console.log("panel open before prompt:", await exec("return !!document.querySelector('.rpanel')")); }
  // Fresh profile: start a chat in the first project (the default workspace or a CLI folder).
  await exec("document.querySelector('[data-testid=new-chat]')?.click();return true");
  await sleep(600);
  await exec("const t=document.querySelector('.composer textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,arguments[0]);t.dispatchEvent(new Event('input',{bubbles:true}));return true", [prompt]);
  await sleep(300);
  await exec("const b=document.querySelector('.composer button[title=Send], .composer button[aria-label=Send], .composer .send')||[...document.querySelectorAll('.composer button')].pop();b.click();return b.outerHTML.slice(0,80)", []);
  const t0 = Date.now();
  let reply = "", tools = [];
  while (Date.now() - t0 < 240000) {
    await sleep(2000);
    const r = await exec("return { busy: !!document.querySelector('.composer .stop, [title=\"Stop\"]'), reply: [...document.querySelectorAll('.bubble.agent')].map(e=>e.innerText).pop()||'', tools: [...document.querySelectorAll('.toolcard summary, .tool-title')].map(e=>e.innerText.split('\\n')[0]).slice(-12), errs: [...document.querySelectorAll('.error-text, .bubble.system')].map(e=>e.innerText).slice(-2) }");
    reply = r.reply; tools = r.tools;
    if (reply.includes(secret) || (!r.busy && Date.now() - t0 > 20000 && reply)) { if (r.errs?.length) console.log("system:", r.errs); break; }
  }
  const png = await call("GET", s("/screenshot")).catch(() => null);
  if (png) writeFileSync("/tmp/live-browser.png", Buffer.from(png, "base64"));
  console.log("tool calls:", JSON.stringify(tools));
  console.log("page requests:", JSON.stringify(seen));
  console.log("agent reply:", reply.slice(0, 400));
  console.log("panel open after:", await exec("return !!document.querySelector('.rpanel')").catch(() => "?"));
  ok = seen.includes("/clicked") && reply.includes(secret);
  console.log(ok ? `PASS: the agent opened the page, clicked, and read ${secret}` : "FAIL");
} catch (e) {
  console.error("live browser FAILED:", e.message);
} finally {
  if (sid) await call("DELETE", s("")).catch(() => {});
  driver.kill();
  http.close();
  process.exit(ok ? 0 : 1);
}
