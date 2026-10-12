/**
 * Scripted fake ACP agent for e2e tests and manual QA.
 *   vite-node scripts/fake-agent.ts -- --port 2420 --secret test
 *
 * Prompt keywords drive scenarios:
 *   "stream"  streamed reply + thought + plan
 *   "tool"    tool_call → tool_call_update (in_progress → completed with content)
 *   "perm"    session/request_permission, then reports the chosen option
 *   "slow"    streams slowly until session/cancel → stopReason "cancelled"
 *   "browser" calls every _supercharge/browser/* method on the client and reports results
 *             (also written to $FAKE_AGENT_REPORT if set)
 */
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { writeFileSync } from "fs";

// Shared across connections (like one agent process serving several clients).
let sessions = 0;
const listed: { sessionId: string; cwd: string; title: string }[] = [];
const known = new Set<string>();
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const port = Number(arg("port", "2420"));
const secret = arg("secret", "test");
const report = process.env.FAKE_AGENT_REPORT;

const HARNESS = `<!doctype html><title>Harness</title><h1>Browser harness</h1><input id=q placeholder=query><button id=go onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('q').value">Go</button><p id=out>idle</p><div style=height:3000px></div>`;
const http = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(req.url?.startsWith("/page2") ? "<!doctype html><title>Page two</title><h1>Two</h1>" : HARNESS);
});
http.listen(port, "127.0.0.1");
const wss = new WebSocketServer({
  server: http,
  verifyClient: (info: any) => new URL(info.req.url, "http://x").searchParams.get("server-key") === secret,
});

wss.on("connection", (ws: WebSocket) => {
  let nextId = 1000;
  const pending = new Map<number, (m: any) => void>();
  const cancelled = new Set<string>();
  const send = (m: any) => ws.send(JSON.stringify({ jsonrpc: "2.0", ...m }));
  const update = (sessionId: string, u: any) => send({ method: "session/update", params: { sessionId, update: u } });
  const say = (sid: string, text: string) => update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const call = (method: string, params: any) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ id, method, params });
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const flaked = new Set<string>();

  ws.on("message", async (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id != null && !m.method) return pending.get(m.id)?.(m), pending.delete(m.id);
    const reply = (result: any) => send({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, _meta: { "supercharge/demo": true } },
          authMethods: [],
          _meta: { agentVersion: "fake-1.0", availableCommands: [{ name: "help", description: "Show help" }, { name: "setup", description: "Configure provider" }] },
        });
      case "session/list":
        return reply({ sessions: listed.map((x) => ({ ...x })) });
      case "session/new":
        known.add(`fake-${++sessions}`);
        listed.splice(0, listed.length, ...listed.filter((x) => x.sessionId !== `fake-${sessions}`));
        listed.push({ sessionId: `fake-${sessions}`, cwd: m.params?.cwd ?? "/tmp", title: "New chat" });
        return reply({
          sessionId: `fake-${sessions}`,
          configOptions: [{ id: "reasoning_effort", name: "Reasoning Effort", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "low", name: "Low" }] }],
        });
      case "session/set_config_option":
        return reply({ configOptions: [] });
      case "session/cancel":
        cancelled.add(m.params.sessionId);
        return;
      case "session/prompt": {
        const sid = m.params.sessionId;
        const text: string = m.params.prompt?.map((b: any) => b.text ?? "").join(" ") ?? "";
        if (!known.has(sid)) return send({ id: m.id, error: { code: -32602, message: "Invalid params: unknown session id" } });
        cancelled.delete(sid);
        if (/modelfail/.test(text))
          return send({ id: m.id, error: { code: -32603, message: "Internal error", data: "responses API error 400: no upstream owns model old-model" } });
        if (/flaky/.test(text) && !flaked.has(sid)) {
          flaked.add(sid);
          return send({ id: m.id, error: { code: -32603, message: "Internal error", data: "upstream timed out" } });
        }
        if (/authfail/.test(text))
          return send({ id: m.id, error: { code: -32603, message: "Internal error", data: "Unauthorized (401): Invalid or expired credentials" } });
        if (/stream/.test(text)) {
          update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it" } });
          update(sid, { sessionUpdate: "plan", entries: [{ content: "Say hello", status: "completed" }, { content: "Say bye", status: "pending" }] });
          for (const w of ["Hello ", "from ", "the ", "fake ", "agent."]) {
            say(sid, w);
            await sleep(30);
          }
        }
        if (/tool/.test(text)) {
          update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run ls -la", kind: "execute", status: "pending" });
          await sleep(50);
          update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
          await sleep(50);
          update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "README.md\nsrc" } }] });
          say(sid, "Tool finished.");
        }
        if (/perm/.test(text)) {
          const r = await call("session/request_permission", {
            sessionId: sid,
            toolCall: { toolCallId: "p1", title: "Delete build folder", rawInput: { path: "dist" } },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Reject", kind: "reject_once" },
              { optionId: "deny-why", name: "No, and tell Zed what to do differently", kind: "reject_once" },
            ],
          });
          const o = r.result?.outcome;
          say(sid, `Permission outcome: ${o?.outcome}${o?.optionId ? `:${o.optionId}` : ""}`);
        }
        if (/slow/.test(text)) {
          for (let i = 0; i < 200 && !cancelled.has(sid); i++) {
            say(sid, `tick${i} `);
            await sleep(100);
          }
          if (cancelled.has(sid)) return reply({ stopReason: "cancelled" });
        }
        if (/browser/.test(text)) {
          const results: Record<string, any> = {};
          const B = (x: string) => `_supercharge/browser/${x}`;
          const step = async (name: string, params: any) => {
            const r = await call(B(name), params);
            results[name] = r.error ? { error: r.error.message } : r.result;
            say(sid, `${name}: ${r.error ? "ERROR " + r.error.message : "ok"}\n`);
            return r.result;
          };
          const page = `http://127.0.0.1:${port}/harness`;
          await step("navigate", { url: page });
          await sleep(800);
          const snap = await step("snapshot", {});
          const input = snap?.elements?.find((e: any) => e.tag === "input");
          await step("type", { ref: input?.ref, text: "supercharge" });
          await step("click", { selector: "#go" });
          results.afterClick = (await call(B("eval"), { expression: "document.getElementById('out').textContent" })).result;
          const shot = await call(B("screenshot"), {});
          results.screenshot = shot.error
            ? { error: shot.error.message }
            : shot.result?.data
              ? { mimeType: shot.result.mimeType, bytes: Buffer.from(shot.result.data, "base64").length }
              : shot.result;
          if (shot.result?.data && process.env.FAKE_AGENT_SHOT) writeFileSync(process.env.FAKE_AGENT_SHOT, Buffer.from(shot.result.data, "base64"));
          say(sid, `screenshot: ${shot.result?.data ? "ok" : "fallback"}\n`);
          await step("scroll", { dy: 800 });
          results.scrollY = (await call(B("eval"), { expression: "window.scrollY" })).result;
          await step("eval", { expression: "document.title" });
          await step("navigate", { url: `http://127.0.0.1:${port}/page2` });
          await sleep(1000);
          results.page2 = (await call(B("eval"), { expression: "document.title" })).result;
          await step("back", {});
          await sleep(800);
          results.afterBack = (await call(B("eval"), { expression: "document.title" })).result;
          if (report) writeFileSync(report, JSON.stringify(results, null, 2));
          say(sid, "```\n" + JSON.stringify(results, null, 1).slice(0, 1500) + "\n```");
        }
        if (/edit/.test(text)) {
          update(sid, {
            sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit src/app.ts", kind: "edit", status: "completed",
            content: [{ type: "diff", path: "src/app.ts", oldText: "const a = 1;\nconst b = 2;\nexport { a, b };", newText: "const a = 1;\nconst b = 3;\nconst c = 4;\nexport { a, b, c };" }],
          });
          say(sid, "Edited.");
        }
        if (/tokens/.test(text)) {
          // Realistic token stream: ~600 small chunks, one every 4 ms, with markdown.
          const words = "The **quick** brown fox `jumps` over the lazy dog and keeps streaming tokens".split(" ");
          for (let i = 0; i < 600; i++) {
            update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: (i % 40 === 39 ? "\n\n" : " ") + words[i % words.length] } });
            await new Promise((r) => setTimeout(r, 4));
          }
        }
        if (/long/.test(text)) {
          for (let i = 0; i < 300; i++) {
            update(sid, { sessionUpdate: i % 2 ? "agent_message_chunk" : "agent_thought_chunk", content: { type: "text", text: `line ${i}` } });
          }
        }
        if (!/stream|tool|perm|slow|browser|modelfail|edit|long|tokens/.test(text)) say(sid, `echo: ${text}`);
        // Usage as an extension notification (turn report) and on the prompt result.
        const usage = { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 200, reasoningTokens: 50, modelCalls: 1, modelUsage: { "fake-model": { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 200, reasoningTokens: 50, modelCalls: 1 } } };
        send({ method: "_supercharge/session/update", params: { sessionId: sid, update: { sessionUpdate: "turn_completed", prompt_id: `p${nextId++}`, stop_reason: "end_turn", usage } } });
        return reply({ stopReason: "end_turn", usage });
      }
      default:
        if (m.id != null) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
  });
});
console.log(`fake ACP agent on ws://127.0.0.1:${port}/ws?server-key=${secret}`);
