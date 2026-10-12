/**
 * Live ACP smoke test against a running `supercharge agent serve`.
 *   ACP_URL=ws://127.0.0.1:2419/ws?server-key=dev-secret npm run smoke
 */
import WebSocket from "ws";
import { AcpClient } from "../src/acp/client";
import { browserClientMeta } from "../src/browser/bridge";

const url = process.env.ACP_URL ?? "ws://127.0.0.1:2419/ws?server-key=dev-secret";
const updates: string[] = [];
const notes: { method: string; params: unknown }[] = [];
const c = new AcpClient({
  url,
  WebSocketImpl: WebSocket as any,
  reconnect: { enabled: false },
  requestTimeoutMs: 20000,
  promptTimeoutMs: Number(process.env.PROMPT_TIMEOUT_MS ?? 90000),
  clientMeta: browserClientMeta(),
  onUpdate: (_s, u) => {
    updates.push(u.sessionUpdate);
    if (u.sessionUpdate === "agent_message_chunk") process.stdout.write((u as any).content?.text ?? "");
  },
  onNotification: (method, params) => notes.push({ method, params }),
  onPermissionRequest: (r) => ({ outcome: "selected", optionId: r.options[0]?.optionId }),
});

const log = (k: string, v: unknown) => console.log(`\n## ${k}\n${JSON.stringify(v, null, 2)}`);
await c.connect();
const init = await c.initialize();
log("initialize", { protocolVersion: init.protocolVersion, agentCapabilities: Object.keys(init.agentCapabilities ?? {}), authMethods: init.authMethods?.map((a) => a.id), agentVersion: (init._meta as any)?.agentVersion, commands: ((init._meta as any)?.availableCommands ?? []).map((c: any) => c.name) });
log("extensions", { methods: c.extensions.methods, features: c.extensions.features });
const sess = await c.newSession(process.env.ACP_CWD ?? process.cwd());
log("session/new", { sessionId: sess.sessionId, configOptions: sess.configOptions?.map((o) => ({ id: o.id, current: o.currentValue, values: o.options?.map((v) => v.value) })) });
try {
  log("session/set_config_option", await c.setConfigOption(sess.sessionId, "reasoning_effort", "medium"));
} catch (e: any) {
  log("session/set_config_option error", e.message);
}
try {
  const r = await c.prompt(sess.sessionId, process.env.ACP_PROMPT ?? "Reply with exactly: pong");
  log("session/prompt", r);
} catch (e: any) {
  log("session/prompt error", { name: e.name, code: e.code, message: e.message, data: e.data });
}
log("update kinds", [...new Set(updates)]);
log("extension notifications", c.extensions.notifications);
c.close();
process.exit(0);
