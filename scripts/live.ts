/**
 * Live end-to-end run against a real agent with a configured provider.
 *   ACP_URL=ws://127.0.0.1:2419/ws?server-key=dev-secret npm run live
 * 1) streamed reply  2) tool call (list files) with permission flow  3) cancel mid-stream
 */
import WebSocket from "ws";
import { AcpClient } from "../src/acp/client";
import { applyUpdate, emptySession, SessionState } from "../src/acp/session";

const url = process.env.ACP_URL ?? "ws://127.0.0.1:2419/ws?server-key=dev-secret";
let state: SessionState = emptySession();
let chunks = 0;
const perms: any[] = [];
const c = new AcpClient({
  url,
  WebSocketImpl: WebSocket as any,
  reconnect: { enabled: false },
  promptTimeoutMs: 120000,
  onUpdate: (_s, u) => {
    state = applyUpdate(state, u);
    if (u.sessionUpdate === "agent_message_chunk") chunks++;
  },
  onPermissionRequest: (r) => {
    perms.push({ title: r.toolCall.title, options: r.options.map((o) => o.kind) });
    const allow = r.options.find((o) => o.kind === "allow_once") ?? r.options[0];
    return { outcome: "selected", optionId: allow.optionId };
  },
});
const out = (k: string, v: unknown) => console.log(`\n## ${k}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);
const lastAgent = () => [...state.items].reverse().find((i) => i.kind === "agent") as any;

await c.connect();
await c.initialize();
const { sessionId } = await c.newSession(process.env.ACP_CWD ?? process.cwd());

let t0 = Date.now();
let r = await c.prompt(sessionId, "In one short sentence, what is ACP (Agent Client Protocol)? No tools.");
out("1 stream", { stopReason: r.stopReason, chunks, ms: Date.now() - t0, text: lastAgent()?.text });

state = emptySession(); chunks = 0; t0 = Date.now();
r = await c.prompt(sessionId, "Use the shell tool to run `ls` here and then run `touch /tmp/studio-perm-test.txt`. Reply with the number of entries from ls.");
out("2 tool", {
  stopReason: r.stopReason,
  ms: Date.now() - t0,
  permissions: perms,
  toolCalls: Object.values(state.toolCalls).map((t) => ({ title: t.title, kind: t.kind, status: t.status, contentItems: t.content.length })),
  text: lastAgent()?.text,
});

state = emptySession(); chunks = 0; t0 = Date.now();
const p = c.prompt(sessionId, "Write a 150-word story about a lighthouse. No tools.");
while (chunks < 3 && Date.now() - t0 < 8000) await new Promise((res) => setTimeout(res, 50));
const chunksAtCancel = chunks;
c.cancel(sessionId);
const r3 = await p.catch((e: any) => ({ stopReason: `error: ${e.message}` }));
out("3 cancel", { stopReason: r3.stopReason, chunksAtCancel, chunksTotal: chunks, ms: Date.now() - t0 });
c.close();
process.exit(0);
