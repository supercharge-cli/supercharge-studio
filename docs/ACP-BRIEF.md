# Supercharge Studio — ACP-only product brief

The UI is an ACP client; Supercharge is the ACP agent.
Protocol surface: (`initialize` → `session/new` → `session/prompt` → `session/update`), plus any extension methods the agent advertises in `initialize`.
**No HTTP inbox path for v1.** Browser and other tools are whatever the agent exposes over ACP (MCP tools, shell, fs).

Docs stamp: Supercharge CLI 1.3.32 · ACP v1.

## Transport

| Mode | Command | Client connects |
|------|---------|-----------------|
| ACP WebSocket (primary for desktop app) | `supercharge agent --always-approve serve --bind 127.0.0.1:2419 --secret TOKEN` | `ws://127.0.0.1:2419/ws?server-key=TOKEN` |
| ACP stdio (IDE / local child) | `supercharge agent --always-approve stdio` | NDJSON on stdin/stdout |

Env: `SUPERCHARGE_AGENT_SECRET` (Supercharge).

Session state survives WebSocket reconnect (Supercharge docs).

## Protocol lifecycle (ACP v1)

1. Client → `initialize` (`protocolVersion: 1`, `clientCapabilities`, `clientInfo`)
2. Optional `authenticate` if required
3. Client → `session/new` `{ cwd, mcpServers, _meta?: { yoloMode, rules, systemPromptOverride, agentProfile } }`
   - or `session/load` / `session/resume` when supported
4. Client → `session/prompt` `{ sessionId, prompt: [{ type: "text", text }] }`
5. Agent → `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, …)
6. Agent may → `session/request_permission` (skip if `--always-approve` / `_meta.yoloMode`)
7. Client may → `session/cancel`
8. Agent completes the `session/prompt` RPC with a `stopReason`

Wire format: JSON-RPC 2.0. WebSocket: one JSON message per frame (or NDJSON if the binary frames that way). Stdio: one JSON object per line.

## App surfaces → ACP

| UI | ACP / extension |
|----|-----------------|
| Chat stream | `session/prompt` + `session/update` |
| Stop | `session/cancel` |
| New chat / project | `session/new` with project `cwd` |
| Resume chat | `session/load` / `session/resume`  |
| Project list | App-local list of folders; each opens a session with that `cwd` + `AGENTS.md` |
| Settings (model / effort) | `session/set_config_option` (`model`, `reasoning_effort`) when advertised |
| Permissions modal | Answer `session/request_permission` |
| Tools / browser | Render `tool_call` / `tool_call_update`; agent runs tools (shell, MCP, browser MCP, extension methods, …) |
| File tree / git pane | Use fs/git extension methods when `initialize` advertises them |
| Memory / rules | Project `AGENTS.md` + session `_meta.rules`; curated memory via agent tools / files under `~/.supercharge` |

## Architecture

```
┌──────────────────────────────────────────────┐
│  Supercharge Studio (Tauri 2 desktop / web)      │
│  chat · projects · settings · tool panels    │
└────────────────────┬─────────────────────────┘
                     │ ACP JSON-RPC over WebSocket
                     ▼
         supercharge agent serve :2419
                     │
         tools · MCP · shell · fs · git · …
```

## Non-goals (v1)

- HTTP inbox (`/v1/chat`, SSE) — daemon fallback only, not the app primary path
- Remote computer-use HTTP endpoints — not used; browser = ACP tools / MCP
- Inventing non-ACP chat-completion shapes for the agent wire

## Launch checklist

1. User installs Supercharge; runs `/setup` once for BYOK provider
2. App starts (or attaches to) `supercharge agent --always-approve serve --bind 127.0.0.1:2419 --secret <keychain>`
3. App connects WS, `initialize`, creates session per project `cwd`
4. Chat UI streams `session/update`; tool cards for tool calls; settings write config options

## References

- https://superchargeai.in/docs/modes
- https://agentclientprotocol.com/protocol/v1/overview
