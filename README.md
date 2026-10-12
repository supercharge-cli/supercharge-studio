# Supercharge Studio

Open-source desktop studio for [Supercharge](https://superchargeai.in). It is a pure
**Agent Client Protocol (ACP)** client: chats, tool cards, permission prompts, settings
and the side browser all go over ACP to a local `supercharge agent serve`
(or `supercharge agent stdio`).

- Collapsible sidebar: **groups → projects → chats** (each project is a session `cwd`)
- Streaming chat with thoughts, plans, inline tool cards, Stop (`session/cancel`) and slash commands
- Side **browser** the agent can see (DOM snapshot) and control (navigate / click / type) via ACP extension methods
- Tools panel driven by `tool_call` / `tool_call_update`
- Settings: transport, agent address & key, auto-start, model / effort (`session/set_config_option`)
- Windows, macOS and Linux via a Tauri 2 shell (~2 MB installer on Linux)

Docs: [docs/ACP-BRIEF.md](docs/ACP-BRIEF.md) · [docs/RUNNING.md](docs/RUNNING.md)

## Quick start

```bash
curl -fsSL https://superchargeai.in/install.sh | bash   # Supercharge CLI
supercharge            # once: run /setup to configure a model provider

npm install
npm run agent          # supercharge agent --always-approve serve --bind 127.0.0.1:2419 --secret dev-secret
npm run dev            # web UI at http://127.0.0.1:5173
npm run tauri:dev      # or the desktop window (auto-starts / attaches to the agent)
```

Default URL: `ws://127.0.0.1:2419/ws?server-key=dev-secret`

## Tests

```bash
npm test         # ACP client vs. mock WebSocket agent, reducer, browser bridge, build smoke
npm run smoke    # live check against a running agent (initialize, session/new, ping prompt)
npm run build
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
