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

### Launcher overrides

`SUPERCHARGE_STUDIO_AGENT=host:port` and `SUPERCHARGE_AGENT_SECRET` override the saved
agent address / key for one run of the desktop app (they are not written to settings).

## Model providers

Settings → Providers stores any number of providers (name, base URL, API format —
Responses, Chat Completions or Messages — and model IDs). Keys go to the OS keychain
(macOS Keychain, Windows Credential Manager, Linux Secret Service); on a Linux machine
without a Secret Service the app falls back to `~/.config/supercharge-studio/secrets.json`
(mode 0600) and says so. **Use** writes the provider into `~/.supercharge/config.toml` as
`[model.studio-<id>-<n>]` tables, makes its first model the default for every agent
role (chat, titles, web search, forks) and restricts the model picker to it, then
restarts the agent if the app started it (otherwise it asks you to restart
`supercharge agent serve`). Override the config path with `SUPERCHARGE_STUDIO_AGENT_CONFIG`.

For local testing a provider can be seeded on first desktop launch from
`SUPERCHARGE_TEST_BASE_URL`, `SUPERCHARGE_TEST_MODEL`, `SUPERCHARGE_TEST_FORMAT` and
`SUPERCHARGE_TEST_API_KEY` (the key is written straight to secure storage).

## Side browser for the agent (MCP)

The desktop app runs a local MCP server (`http://127.0.0.1:<random port>/mcp/<random token>`)
and passes it to the agent in `session/new.mcpServers` when the agent advertises
`mcpCapabilities.http`. The agent then gets these tools: `browser_navigate`,
`browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`,
`browser_scroll`, `browser_back`, `browser_eval`. Calls are executed in the visible
side browser.

Screenshots are native captures of the visible area: WebKitGTK snapshot (Linux),
`WKWebView takeSnapshot` (macOS), WebView2 `CapturePreview` (Windows). If capture fails,
`screenshot` returns `{ fallback: "snapshot", ... }` with the text snapshot.

## Side browser control (ACP extensions)

The app advertises client-side ACP extension methods in
`clientCapabilities._meta.supercharge.browser.methods`. The agent can call them as
JSON-RPC requests to the app:

| Method | Params | Result |
|---|---|---|
| `_supercharge/browser/navigate` | `{ url }` | `{ url }` |
| `_supercharge/browser/snapshot` | `{}` | `{ url, title, text, elements: [{ ref, tag, text, href }] }` |
| `_supercharge/browser/screenshot` | `{}` | `{ mimeType, data }` (base64 PNG) or snapshot fallback |
| `_supercharge/browser/click` | `{ ref }` or `{ selector }` | `{ ok }` |
| `_supercharge/browser/type` | `{ ref \| selector, text, submit? }` | `{ ok }` |
| `_supercharge/browser/scroll` | `{ dy }` | `{ ok }` |
| `_supercharge/browser/eval` | `{ expression }` | `{ value }` |
| `_supercharge/browser/back` | `{}` | `{ ok }` |

The browser is a native child webview (desktop only). Scripts run in the page and
the app reads results back by polling the webview, so pages loaded in the side browser
get no access to app commands. On Linux the browser is placed in a GTK overlay above
the app UI (GTK cannot position child webviews absolutely).

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

## End-to-end tests

```bash
npx playwright install chromium
npm run e2e        # web UI + scripted fake ACP agent (scripts/fake-agent.ts)
```

Covers streaming (thought, plan, chunks), tool cards + tools panel, permission dialog,
Stop/cancel, sidebar group/project/chat create/rename/delete + persistence, slash menu,
settings, missing-provider hint and stale-session recovery.

`npm run fake-agent -- --port 2422 --secret qa` runs the fake agent by hand; prompting
`browser` makes it drive every `_supercharge/browser/*` method in the desktop app:

```bash
FAKE_AGENT_REPORT=/tmp/browser.json npm run fake-agent -- --port 2422 --secret qa &
SUPERCHARGE_STUDIO_AGENT=127.0.0.1:2422 SUPERCHARGE_AGENT_SECRET=qa ./src-tauri/target/release/supercharge-studio
```

`npm run live` exercises a real agent with a configured provider (reply, tool call with
permission, cancel). Keep prompts short; it uses real tokens.

## Linux packages

CI ships `.deb` and `.rpm` (~2 MB each; they depend on the system WebKitGTK).
An AppImage is not built by default: it bundles WebKitGTK and GTK (~80 MB).
Build one locally with `npx tauri build --bundles appimage` if needed.

## Usage data source

The Usage screen (sidebar → **Usage**, or `Ctrl Shift U`) is fed only by what the agent
reports over ACP:

1. **Preferred:** the agent's extension notification `_<namespace>/session/update` with
   `sessionUpdate: "turn_completed"` and a `usage` object (`inputTokens`, `outputTokens`,
   `cachedReadTokens`, `cacheCreationTokens`, `reasoningTokens`, optional per-model
   `modelUsage`). Any `_*/session/update` method is accepted.
2. **Fallback:** a `usage` object on the `session/prompt` result, used only when no
   turn report arrived for that turn.

Records (time, model, provider, token counts) are stored locally in `localStorage`
(`supercharge-studio/usage/v1`); per-model prices (USD per 1M input/output/cached tokens)
are stored under `supercharge-studio/pricing/v1`. Nothing is sent anywhere. Costs are
estimates from your prices; **Clear** wipes the history.

## Mobile gateway

Settings → **Devices** turns on an end-to-end encrypted relay so a phone can follow and
drive your chats.

- Listens on `ws://<LAN IP>:2420/gw` (port configurable). For use outside the LAN,
  put any TLS tunnel in front of it and paste its `wss://…/gw` address into **Public URL**;
  the tunnel only ever sees ciphertext.
- **Pair:** click **New code**, scan the QR in the app (or paste the `scstudio://pair?…`
  link), then click **Allow** on the computer. Codes expire after 120 s and work once.
- Crypto: per-device key `K = HMAC-SHA256(pairSecret, "supercharge-gw/device-key")`,
  mutual HMAC challenge handshake, per-connection session key, AES-256-GCM frames with
  direction-tagged counters (replays are dropped). Device keys live in the OS keychain;
  the device list is `~/.config/supercharge-studio/devices.json`. Revoke a device from
  the same screen.
- Devices may call `initialize`, `session/list|load|new|prompt|cancel` and
  `_supercharge/focus`. Permission requests go to the computer and every online device;
  the first answer wins and the others are dismissed. "Continue on phone" (command
  palette) sends a handoff prompt to paired devices.

Tests: `npx playwright test e2e/mobile.spec.ts` drives the mobile UI against
`scripts/fake-gateway.ts`. `scripts/live-mobile.ts <pair-uri>` pairs the mobile UI with a
real running desktop gateway.

## Mobile app builds

The phone app is a separate Tauri 2 app in `mobile/` sharing the React UI
(`mobile.html` → `src/mobile`, built into `dist-mobile`).

```bash
npm run dev:mobile          # mobile UI in a browser at http://127.0.0.1:5174/mobile.html
npm run build:mobile        # web bundle only

# Android (JDK 17+, Android SDK + NDK; set ANDROID_HOME and NDK_HOME)
cd mobile
npx tauri android build --debug --apk --target x86_64           # emulator debug build
npx tauri android build --apk --split-per-abi --target aarch64 armv7 x86_64   # release
```

Release builds are stripped (`strip`, LTO, `opt-level = "s"`, `panic = "abort"`) and split
per ABI; they come out unsigned in `mobile/src-tauri/gen/android/app/build/outputs/apk/`
— sign with `apksigner` before installing. Typical sizes: arm64 ≈ 6.0 MiB,
armv7 ≈ 4.7 MiB, x86_64 ≈ 6.4 MiB.

iOS (macOS + Xcode + xcodegen): `cd mobile && npx tauri ios init && TAURI_APP_PATH=$PWD/src-tauri npx tauri ios build --debug --target aarch64-sim`.
CI builds the Android release APKs and an unsigned iOS simulator build on every push.
