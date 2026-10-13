// Live check of queue + steer against the real agent in the built app (fresh profile).
//   node scripts/live-steer.mjs <app binary>
// 1) queue: a message sent while a turn runs waits as a chip and is sent when the turn ends.
// 2) steer: a queued chip's Steer button redirects the running turn (native steer when the
//    agent advertises it, else cancel-and-resend with the text appended).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BIN = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), "scs-steer-"));
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
const state = () => exec("return { busy: !!document.querySelector('.composer button[aria-label=Stop]'), chips: [...document.querySelectorAll('[data-testid=queued-text]')].map(e=>e.innerText), agent: [...document.querySelectorAll('.bubble.agent')].map(e=>e.innerText), user: [...document.querySelectorAll('.bubble.user')].map(e=>e.innerText), sys: [...document.querySelectorAll('.bubble.system')].map(e=>e.innerText) }");
const typeSend = async (t) => {
  await exec("const t=document.querySelector('.composer textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,arguments[0]);t.dispatchEvent(new Event('input',{bubbles:true}));return true", [t]);
  await sleep(250);
  await exec("const b=document.querySelector('[data-testid=queue-send]')||document.querySelector('.composer button[aria-label=Send]');b.click();return true");
};
const until = async (f, ms, label) => { const end = Date.now() + ms; for (;;) { const st = await state(); if (f(st)) return st; if (Date.now() > end) throw new Error(`timeout: ${label} ${JSON.stringify(st).slice(0, 500)}`); await sleep(700); } };
const LONG = "Write the numbers from 1 to 400 in words, one per line, no tools, nothing else.";
let ok = true;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(W + "/status"); break; } catch { await sleep(200); } }
  sid = (await call("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: BIN }, pageLoadStrategy: "none" } } })).sessionId;
  for (let i = 0; i < 120; i++) { const st = await exec("return document.querySelector('.status')?.textContent||''").catch(() => ""); if (st === "open") break; await sleep(500); }
  await exec("document.querySelector('button[title=\"Close (Esc)\"]')?.click();return true");
  await exec("document.querySelector('[data-testid=new-chat]')?.click();return true"); await sleep(600);

  // 1) queue
  await typeSend(LONG);
  await until((x) => x.busy, 30000, "turn 1 running");
  await typeSend("Reply with exactly QUEUED-OK and nothing else.");
  const q = await state();
  console.log("[queue] chips while running:", JSON.stringify(q.chips), "busy:", q.busy);
  if (q.chips.length !== 1) ok = false;
  const done1 = await until((x) => !x.busy && x.chips.length === 0 && x.agent.some((a) => a.includes("QUEUED-OK")), 240000, "queued message answered");
  console.log("[queue] user bubbles:", JSON.stringify(done1.user.map((u) => u.slice(0, 40))), "| last reply:", done1.agent.at(-1));

  // 2) steer
  await typeSend(LONG);
  await until((x) => x.busy && x.agent.length > done1.agent.length, 60000, "turn 2 streaming");
  await typeSend("Change of plan: ignore the numbers and reply with exactly STEER-OK and nothing else.");
  await exec("document.querySelector('[data-testid=queued-steer]').click();return true");
  const done2 = await until((x) => !x.busy && x.agent.at(-1)?.includes("STEER-OK"), 240000, "steered reply");
  console.log("[steer] system:", JSON.stringify(done2.sys.slice(-2)), "| last reply:", done2.agent.at(-1));
  const png = await call("GET", s("/screenshot")).catch(() => null);
  if (png) writeFileSync("/tmp/live-steer.png", Buffer.from(png, "base64"));
} catch (e) { ok = false; console.error("live steer FAILED:", e.message); }
finally { if (sid) await call("DELETE", s("")).catch(() => {}); driver.kill(); console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1); }
