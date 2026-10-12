# Running and testing

## Requirements

- Node 20+
- Supercharge CLI on `PATH` (`supercharge`), configured once with `/setup`
- Desktop builds: Rust stable + platform webview deps
  - Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`
  - macOS: Xcode command line tools
  - Windows: MSVC build tools + WebView2 (bootstrapped by the installer)

## Against a real agent

```bash
supercharge agent --always-approve serve --bind 127.0.0.1:2419 --secret dev-secret
npm run dev        # web UI at http://127.0.0.1:5173
# or
npm run tauri:dev  # desktop window
```

In the desktop app, "Start agent automatically" (Settings) probes the address and
spawns `supercharge agent serve` only when nothing is listening; otherwise it
attaches. Set `SUPERCHARGE_BIN` to use a non-default binary. Choose the "ACP stdio"
transport to have the app run `supercharge agent stdio` as a child process instead.

Manual check list:

1. Status pill shows `open`; Settings lists any agent extension methods.
2. Pick a project → type a prompt → reply streams in.
3. Ask for a shell command → a tool card appears and moves pending → completed.
4. Press **Stop** mid-turn → turn ends with `stopped: cancelled`.
5. Restart the agent → pill shows `reconnecting`, then `open` again.
6. Untick "Always approve" (and run the agent without `--always-approve`) → permission dialog.

## Side browser control

The app advertises client-side ACP extension methods in
`clientCapabilities._meta.supercharge.browser.methods`. The agent can call them as
JSON-RPC requests to the app:

| Method | Params | Result |
|---|---|---|
| `_supercharge/browser/navigate` | `{ url }` | `{ url }` |
| `_supercharge/browser/snapshot` | `{}` | `{ url, title, text, elements: [{ ref, tag, text, href }] }` |
| `_supercharge/browser/click` | `{ ref }` or `{ selector }` | `{ ok }` |
| `_supercharge/browser/type` | `{ ref \| selector, text, submit? }` | `{ ok }` |
| `_supercharge/browser/scroll` | `{ dy }` | `{ ok }` |
| `_supercharge/browser/eval` | `{ expression }` | `{ value }` |
| `_supercharge/browser/back` | `{}` | `{ ok }` |

The browser is a native child webview (desktop only). Pages in it may call exactly
one app command (`browser_result`) to return script results.

## Tests

```bash
npm test          # vitest: ACP client against an in-process mock WebSocket agent,
                  # session/update reducer, and a production build smoke test
npm run smoke     # live: initialize, session/new, set_config_option, ping prompt
npm run build     # type-check + bundle
cd src-tauri && cargo check
```

CI (`.github/workflows/ci.yml`) runs tests + build on Ubuntu, macOS and Windows,
then builds desktop bundles (deb/AppImage, universal dmg, msi/nsis).

## Live compatibility notes (Supercharge CLI 1.3.30)

- `initialize` advertises `loadSession`, `sessionCapabilities` (`list`, `resume`, `close`),
  an `authMethods` entry for terminal setup, and slash commands in `_meta.availableCommands`.
- Agent extensions are namespaced capability flags in `_meta` (shown under
  Settings → Agent extensions) plus extension notifications (`_<namespace>/...`) that
  the client records as they arrive. No callable extension *methods* are advertised.
- `session/new` returns `configOptions` (`model`, `reasoning_effort`);
  `session/set_config_option { sessionId, configId, value }` returns the updated list.
- Extra update kinds: `config_option_update`, `session_info_update` (chat title).
- Without a configured provider, `session/prompt` fails with JSON-RPC `-32603`
  and the real cause (HTTP 401) in `error.data`; the app shows a `/setup` hint.
