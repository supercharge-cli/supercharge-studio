# Supercharge Studio Mobile — companion app plan

Goal: follow and steer Supercharge sessions from a phone, using the desktop app as a
**gateway**. The phone never talks to model providers and never holds provider keys;
everything still runs through Supercharge over ACP on the desktop.

```
 phone (Studio Mobile) ──TLS/WSS──▶ desktop gateway (Studio) ──ACP──▶ supercharge agent serve
         ▲   pairing (QR + token)          │ relays session/update, permissions, cancel
         └──── push: "permission needed" ◀─┘
```

## 1. Desktop gateway

A new module in the desktop shell (Rust, `src-tauri/src/gateway.rs`), off by default.

- **Listener**: WebSocket on `0.0.0.0:<port>` (LAN) with TLS using a self-signed
  certificate generated on first enable; the certificate fingerprint is part of the
  pairing payload (certificate pinning on the phone). Optional tunnel mode: the user
  supplies a tunnel endpoint (their own reverse proxy / tunnel); the gateway connects
  out, so nothing is exposed on the LAN.
- **Protocol**: plain ACP JSON-RPC, one message per frame, scoped to sessions the
  phone is allowed to see. The gateway is an ACP *agent* to the phone and multiplexes
  onto the desktop's single ACP *client* connection to `supercharge agent serve`:
  - `initialize` → gateway capabilities (`loadSession`, `sessionCapabilities.list`).
  - `session/list` → sessions from the desktop's project/chat tree (group, project, title, cwd).
  - `session/load` → replays buffered `session/update` history held by the desktop,
    then streams live updates.
  - `session/prompt`, `session/cancel`, `session/set_config_option` → forwarded.
  - `session/request_permission` from the agent → fanned out to desktop **and** phone;
    first answer wins, the other side gets `_supercharge/permission/resolved`.
  - Extensions: `_supercharge/presence` (who is watching a session),
    `_supercharge/browser/screenshot` (read-only view of the side browser).
- **Never relayed**: provider settings, API keys, agent server key, local file paths
  outside project `cwd`s, agent→client fs/terminal methods.

## 2. Pairing

1. Desktop → Settings → Mobile → "Pair a phone" shows a QR code with
   `scstudio://pair?h=<host:port>&fp=<sha256 cert fingerprint>&t=<one-time token>&n=<desktop name>`.
2. The one-time token is 128-bit random, valid for 2 minutes, single use.
3. Phone connects (pins `fp`), sends `_supercharge/pair { token, deviceName, devicePublicKey }`.
4. Desktop asks the user to confirm ("Allow Pixel 9 to control your sessions?").
5. Desktop stores the device public key (OS keychain) and returns a device id.
   Later connections authenticate with a signed challenge (Ed25519) — no reusable
   bearer secret is ever stored on the phone.
6. Devices can be revoked from desktop Settings; revocation closes live sockets.

## 3. Session continuity / handoff

- Sessions live in the agent; desktop and phone are both views. The desktop keeps a
  bounded ring buffer of updates per session so the phone can catch up after
  `session/load` without asking the agent to replay.
- **Handoff desktop → phone**: "Continue on phone" sends a push with a deep link
  `scstudio://session/<id>`; opening it calls `session/load` and scrolls to the end.
- **Handoff phone → desktop**: the desktop marks sessions with new phone activity in the
  sidebar and can jump straight to them.
- Drafts sync via `_supercharge/draft { sessionId, text }` (last writer wins).
- If the desktop is asleep or offline the phone shows sessions read-only from its
  cache and queues prompts until the gateway is reachable again.

## 4. Push notifications

- Triggers: permission requested, turn finished (`stopReason`), errors, optional
  "agent mentioned you" when a plan step completes.
- Delivery: APNs (iOS) / FCM (Android) via a minimal relay that only sees an opaque
  device token and a content-free payload (`{ kind: "permission", sessionId }`). The
  phone fetches details over the gateway after waking. The relay is optional and
  self-hostable; without it, notifications only arrive while the app is foregrounded
  or holding a background connection (Android foreground service).
- Actionable notifications ("Allow once" / "Reject") answer the permission request
  through the gateway with the device signature.

## 5. Technology choice

**Tauri 2 mobile** (iOS + Android) sharing the existing React UI and ACP client.

- One codebase: `src/acp/*` (client, reducer, transports) and the chat/tool components
  are reused as-is; only the shell (navigation, pairing scanner, push) is new.
- Small binaries and native webviews, consistent with the desktop app.
- Rust side reuses gateway/pairing crypto (Ed25519, cert pinning) from the desktop.
- Plugins exist for barcode scanning, notifications, biometric unlock and deep links.

React Native was considered: better native feel and a mature push ecosystem, but it
would mean re-implementing the UI and duplicating the ACP client in a second runtime.
We can revisit if Tauri mobile push/background limits become blocking.

## 6. Security model

- Default off; LAN listener only when enabled; tunnel mode never opens inbound ports.
- TLS everywhere, certificate pinned from the QR code; no plaintext fallback.
- Device identity = Ed25519 key in the phone's secure enclave / keystore; desktop
  stores public keys only. Challenge-response on every connection.
- Least privilege per device: read-only, or read + prompt, or read + prompt + approve
  permissions (configurable). Approving permissions from the phone can require
  biometric unlock.
- The gateway whitelists ACP methods (section 1); everything else is rejected.
- Rate limiting and an audit log (device, method, session, time) in desktop Settings.
- Provider keys and the agent server key never leave the desktop.

## 7. Milestones

| # | Milestone | Done when |
|---|-----------|-----------|
| M0 | Gateway skeleton (desktop) | Authenticated WS relay with method whitelist; unit tests with a mock phone client |
| M1 | Pairing | QR + one-time token + device keys; revoke; tests for expiry/replay |
| M2 | Mobile shell | Tauri 2 mobile app builds for iOS/Android; session list + read-only view |
| M3 | Interactive | Prompt, cancel, permission answers from phone; first-answer-wins |
| M4 | Continuity | Update ring buffer, `session/load` catch-up, handoff deep links, drafts |
| M5 | Push | Optional relay, APNs/FCM, actionable permission notifications |
| M6 | Hardening | TLS pinning, audit log, rate limits, per-device scopes, external review |
| M7 | Release | Store listings, docs, CI for mobile builds |
