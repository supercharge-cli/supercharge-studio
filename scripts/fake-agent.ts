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
 *   "addcli"  (FAKE_AGENT_CLI=1) adds a session in /srv/delta and sends _supercharge/sessions/changed
 *
 * FAKE_AGENT_CLI=1 behaves like the Supercharge CLI's session store: session/list across every
 * folder (paginated, 2 per page), session/load replays history, and one old session fails to
 * load with -32050 model_not_configured until session/set_model picks a configured model.
 */
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { writeFileSync } from "fs";

// Session state is per connection, unless FAKE_AGENT_SHARED=1 (one agent serving several
// clients, as the headless server e2e needs).
type Listed = { sessionId: string; cwd: string; title?: string; updatedAt?: string };
type St = { n: number; listed: Listed[]; known: Set<string>; modelFixed?: boolean; loads: { sessionId: string; cwd: string; mcp: string[] }[] };
const CLI = process.env.FAKE_AGENT_CLI === "1";
const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const cliSeed = (): Listed[] => [
  { sessionId: "cli-a1", cwd: "/srv/alpha", title: "Fix login bug", updatedAt: ago(5) },
  { sessionId: "cli-b1", cwd: "/srv/beta", title: "Write docs", updatedAt: ago(90) },
  { sessionId: "cli-a2", cwd: "/srv/alpha", title: "Refactor auth", updatedAt: ago(60 * 26) },
  { sessionId: "cli-old", cwd: "/home/u/gamma", updatedAt: ago(60 * 24 * 9) },
];
const fresh = (): St => { const listed = CLI ? cliSeed() : []; return { n: 0, listed, known: new Set(listed.map((x) => x.sessionId)), loads: [] }; };
const shared = fresh();
// CLI mode: sessions live in the agent's store, so they survive a dropped connection ("restart").
const cliStore: St | null = CLI ? { n: 0, listed: [], known: new Set(), loads: [] } : null;
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
  // CLI mode: seeded sessions and their flags are per connection (tests stay independent);
  // sessions created with session/new persist in cliStore across reconnects.
  const st = cliStore ? { ...fresh(), n: cliStore.n } : process.env.FAKE_AGENT_SHARED === "1" ? shared : fresh();
  if (cliStore) for (const x of cliStore.listed) { st.listed.push(x); st.known.add(x.sessionId); }
  // MCP servers attached per session on THIS connection (lost on restart until new/load/resume).
  const attached = new Map<string, string[]>();
  const steers = new Map<string, string[]>();
  const attach = (sid: string) => attached.set(sid, (m0().params?.mcpServers ?? []).map((x: any) => x.name));
  let cur: any = null;
  const m0 = () => cur;
  const { listed, known } = st;
  let nextId = 1000;
  const pending = new Map<number, (m: any) => void>();
  const cancelled = new Set<string>();
  const modelChoices = new Map<string, string>();
  const reasoningChoices = new Map<string, string>();
  const permissionChoices = new Map<string, string>();
  const modeChoices = new Map<string, string>();
  const modesFor = (sid: string) => ({ currentModeId: modeChoices.get(sid) ?? "default", availableModes: [{ id: "default", name: "Agent", description: "Work on the task" }, { id: "plan", name: "Plan", description: "Plan before changing files" }] });
  const optionsFor = (sid: string) => [
    { id: "model", name: "Model", currentValue: modelChoices.get(sid) ?? "studio-test-1", options: [{ value: "studio-test-1", name: "First" }, { value: "studio-test-2", name: "Second" }] },
    { id: "reasoning_effort", name: "Reasoning Effort", currentValue: reasoningChoices.get(sid) ?? "high", options: [{ value: "high", name: "High" }, { value: "low", name: "Low" }] },
    { id: "permission_mode", name: "Tool permissions", currentValue: permissionChoices.get(sid) ?? "ask", options: [{ value: "ask", name: "Ask" }, { value: "always-approve", name: "Always approve" }] },
  ];
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
    cur = m;
    if (m.id != null && !m.method) return pending.get(m.id)?.(m), pending.delete(m.id);
    const reply = (result: any) => send({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: 1,
          agentCapabilities: CLI
            ? { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, mcpCapabilities: { http: true }, ...(process.env.FAKE_AGENT_STEER === "1" ? { _meta: { supercharge: { steer: true } } } : {}) }
            : { loadSession: false, _meta: { "supercharge/demo": true } },
          authMethods: [],
          _meta: { agentVersion: "fake-1.0", availableCommands: [{ name: "help", description: "Show help" }, { name: "setup", description: "Configure provider" }] },
        });
      case "session/list": {
        if (!CLI) return reply({ sessions: listed.map((x) => ({ ...x })) });
        const all = listed.filter((x) => !m.params?.cwd || x.cwd === m.params.cwd);
        const at = Number(m.params?.cursor ?? 0);
        return reply({ sessions: all.slice(at, at + 2), ...(at + 2 < all.length ? { nextCursor: String(at + 2) } : {}) });
      }
      case "session/load": {
        if (!CLI) return send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
        const sid = m.params?.sessionId;
        st.loads.push({ sessionId: sid, cwd: m.params?.cwd, mcp: (m.params?.mcpServers ?? []).map((x: any) => x.name) });
        if (report) writeFileSync(report, JSON.stringify({ loads: st.loads }, null, 2));
        if (!known.has(sid)) return send({ id: m.id, error: { code: -32602, message: "unknown session id" } });
        if (sid === "cli-old" && !st.modelFixed)
          return send({ id: m.id, error: { code: -32050, message: "model_not_configured", data: { requested: "retired-model", configured: ["model-a", "model-b"] } } });
        attach(sid);
        update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text: `earlier question in ${sid}` } });
        say(sid, `History of ${sid} in ${m.params?.cwd}`);
        return reply({ configOptions: optionsFor(sid), modes: modesFor(sid) });
      }
      case "_supercharge/session/steer": {
        if (process.env.FAKE_AGENT_STEER !== "1") return send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
        const sid = m.params?.sessionId;
        steers.set(sid, [...(steers.get(sid) ?? []), (m.params?.prompt ?? []).map((b: any) => b.text ?? "").join(" ")]);
        return reply({ status: "queued" });
      }
      case "session/resume": {
        if (!CLI) return send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
        if (!known.has(m.params?.sessionId)) return send({ id: m.id, error: { code: -32602, message: "unknown session id" } });
        attach(m.params.sessionId);
        return reply({ configOptions: optionsFor(m.params.sessionId), modes: modesFor(m.params.sessionId) });
      }
      case "session/set_model":
        if (!CLI) return send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
        st.modelFixed = m.params?.modelId === "model-a" || m.params?.modelId === "model-b";
        return reply({});
      case "session/new":
        known.add(`fake-${++st.n}`);
        if (cliStore) { cliStore.n = st.n; }
        attach(`fake-${st.n}`);
        listed.splice(0, listed.length, ...listed.filter((x) => x.sessionId !== `fake-${st.n}`));
        listed.push({ sessionId: `fake-${st.n}`, cwd: m.params?.cwd ?? "/tmp", title: "New chat", ...(CLI ? { updatedAt: new Date().toISOString() } : {}) });
        if (cliStore) cliStore.listed.push(listed[listed.length - 1]);
        if (CLI) setTimeout(() => send({ method: "_supercharge/sessions/changed", params: {} }), 20);
        return reply({
          sessionId: `fake-${st.n}`,
          configOptions: optionsFor(`fake-${st.n}`),
          modes: modesFor(`fake-${st.n}`),
        });
      case "session/set_config_option": {
        const sid = m.params?.sessionId;
        if (!known.has(sid)) return send({ id: m.id, error: { code: -32602, message: "unknown session id" } });
        if (m.params?.configId === "model") modelChoices.set(sid, m.params.value);
        if (m.params?.configId === "reasoning_effort") reasoningChoices.set(sid, m.params.value);
        if (m.params?.configId === "permission_mode") {
          if (!["ask", "always-approve"].includes(m.params.value)) return send({ id: m.id, error: { code: -32602, message: "Invalid permission mode" } });
          permissionChoices.set(sid, m.params.value);
        }
        const options = optionsFor(sid);
        update(sid, { sessionUpdate: "config_option_update", configOptions: options });
        return reply({ configOptions: options });
      }
      case "session/set_mode": {
        const sid = m.params?.sessionId;
        if (!known.has(sid) || !["default", "plan"].includes(m.params?.modeId)) return send({ id: m.id, error: { code: -32602, message: "Invalid work mode" } });
        modeChoices.set(sid, m.params.modeId);
        update(sid, { sessionUpdate: "current_mode_update", currentModeId: m.params.modeId });
        return reply({});
      }
      case "session/cancel":
        cancelled.add(m.params.sessionId);
        return;
      case "session/prompt": {
        const sid = m.params.sessionId;
        const text: string = m.params.prompt?.map((b: any) => b.text ?? "").join(" ") ?? "";
        if (!known.has(sid)) return send({ id: m.id, error: { code: -32602, message: "Invalid params: unknown session id" } });
        cancelled.delete(sid);
        if (CLI && /mcpcheck/.test(text)) say(sid, `mcp attached: ${(attached.get(sid) ?? []).join(",") || "none"}`);
        if (CLI && /dropconn/.test(text)) { say(sid, "restarting"); setTimeout(() => ws.terminate(), 50); return reply({ stopReason: "end_turn" }); }
        if (CLI && /addcli/.test(text)) {
          listed.unshift({ sessionId: "cli-d1", cwd: "/srv/delta", title: "Started in the terminal", updatedAt: new Date().toISOString() });
          known.add("cli-d1");
          send({ method: "_supercharge/sessions/changed", params: {} });
        }
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
          if (permissionChoices.get(sid) === "always-approve") {
            say(sid, "Permission outcome: auto-approved");
          } else {
            const request = async (id: string, title: string) => {
              const r = await call("session/request_permission", {
                sessionId: sid,
                toolCall: { toolCallId: id, title, rawInput: { path: "dist" } },
                options: [
                  { optionId: "allow", name: "Allow once", kind: "allow_once" },
                  { optionId: "deny", name: "Reject", kind: "reject_once" },
                  { optionId: "deny-why", name: "No, and tell Zed what to do differently", kind: "reject_once" },
                ],
              });
              const o = r.result?.outcome;
              say(sid, `Permission outcome: ${o?.outcome}${o?.optionId ? `:${o.optionId}` : ""} (${id})`);
            };
            await Promise.all([request("p1", "Delete build folder"), ...(/two perm/.test(text) ? [request("p2", "Write config file")] : [])]);
          }
        }
        if (/slow/.test(text) && !/no-slow/.test(text)) {
          for (let i = 0; i < 200 && !cancelled.has(sid); i++) {
            const st2 = steers.get(sid);
            if (st2?.length) { say(sid, `steered: ${st2.splice(0).join(" + ")} `); if (/finish/.test(text)) break; }
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
        // Attachments: report each non-text block so tests can check what the client sent.
        const att = (m.params?.prompt ?? []).filter((b: any) => b?.type && b.type !== "text");
        if (att.length) say(sid, `attachments: ${att.map((b: any) => b.type === "image" ? `image(${b.mimeType})` : b.type === "resource" ? `resource(${decodeURIComponent(String(b.resource?.uri ?? "").split("/").pop() ?? "")}${b.resource?.text != null ? ",text" : ",blob"})` : `link(${b.name})`).join(" ")} `);
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
