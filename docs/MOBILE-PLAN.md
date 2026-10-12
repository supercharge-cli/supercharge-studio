# Supercharge Studio Mobile — companion app plan

Goal: follow and steer Supercharge sessions from a phone, using the desktop app as a
**gateway**. The phone never talks to model providers and never holds provider keys;
everything still runs through Supercharge over ACP on the desktop.

```
 phone (Studio Mobile) ──TLS/WSS──▶ desktop gateway (Studio) ──ACP──▶ supercharge agent serve
         ▲   pairing (QR + token)          │ relays session/update, permissions, cancel
         └──── push: "permission needed" ◀─┘
```

## 1. Desktop gateway (implemented)

`src-tauri/src/gateway.rs` (secure pipe) + `src/gateway/hub.ts` (ACP logic). Off by default;
enable it in **Settings → Devices**.

- **Listener**: WebSocket at `ws://<lan-ip>:2420/gw` (Local network), or `127.0.0.1:<port>` when
  the user puts it behind their own tunnel (set a *Public URL* such as `wss://…/gw`; it goes into
  the QR code). Security does not depend on the transport: every frame is end-to-end encrypted
  and authenticated between the phone and the desktop, so a tunnel or the Wi-Fi only sees ciphertext.
- **Protocol**: plain ACP JSON-RPC inside encrypted frames. The hub acts as an ACP *agent* to
  each device and multiplexes onto the desktop's ACP *client* connection to `supercharge agent serve`:
  - `initialize` → `loadSession`, `sessionCapabilities.list`, `_meta.supercharge.gateway.projects`.
  - `session/list` → chats that have an agent session, with group/project in `_meta`.
  - `session/load` → replays the hub's buffered `session/update`s (up to 3000 per session; the
    desktop loads the session from the agent first if needed), then streams live updates.
  - `session/new` (`_meta.projectId` or `cwd`), `session/prompt`, `session/cancel` → forwarded;
    prompts from a phone appear in the desktop chat tagged with the device name.
  - `session/request_permission` → fanned out to the desktop dialog **and** every connected
    device; the first answer wins; the others get `_supercharge/permission/resolved`.
  - Handoff: `_supercharge/handoff { sessionId }` (desktop → phone, from the command palette),
    `_supercharge/focus { sessionId }` (phone → desktop opens that chat),
    `_supercharge/sessions/changed` when the list changes.
- **Whitelist**: any other method (fs/*, terminal/*, provider settings, keys…) is rejected with
  `-32601`. Provider keys and the agent server key never leave the desktop.

## 2. Pairing and crypto (implemented)

1. Settings → Devices → **Show pairing code** shows a QR code (and a copyable code):
   `scstudio://pair?u=<ws url>&i=<pairing id>&k=<32-byte secret, base64url>&n=<desktop name>`.
   The pairing id is single use and expires after 120 s.
2. Both sides derive the device key `K = HMAC-SHA256(k, "supercharge-gw/device-key")`.
   **`k` and `K` are never sent over the network.**
3. Handshake (JSON text frames): `hello {id, nc}` → `challenge {ns}` →
   `auth {mac = HMAC(sk, "client"|nc|ns)}` → `ok {mac = HMAC(sk, "server"|nc|ns), deviceId}`, with
   `sk = HMAC(K, "supercharge-gw/session"|nc|ns)` and fresh 128-bit nonces on both sides, so both
   ends prove knowledge of `K` and every connection gets a new key.
4. For a pairing id the desktop asks the user to **Allow/Reject** the named device before
   finishing; on Allow it assigns a device id and stores `K` in the OS keychain
   (account `gateway-device-<id>`); device metadata lives in `devices.json` (no keys).
5. Frames: `counter (8 bytes BE) | AES-256-GCM(sk, nonce = direction(4) | counter(8))`.
   Counters must strictly increase (replays and reordering are rejected) and the direction in
   the nonce stops reflection. The phone uses WebCrypto (`src/gateway/crypto.ts`); a shared
   test vector checks the two implementations agree (`cargo test` and `tests/gateway.test.ts`).
6. Devices can be revoked from Settings → Devices; that deletes the key and closes the socket.

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

**Tauri 2 mobile** (Android, iOS kept buildable) sharing the existing React UI and ACP client.

- One codebase: `src/acp/*` (client, reducer, transports) and the chat/tool components
  are reused as-is; only the shell (navigation, pairing scanner, push) is new.
- Small binaries and native webviews, consistent with the desktop app.
- Rust side reuses gateway/pairing crypto (Ed25519, cert pinning) from the desktop.
- Plugins exist for barcode scanning, notifications, biometric unlock and deep links.

React Native was considered: better native feel and a mature push ecosystem, but it
would mean re-implementing the UI and duplicating the ACP client in a second runtime.
We can revisit if Tauri mobile push/background limits become blocking.

## 6. Security model

- Default off. *Local network* mode listens on the LAN; *this computer only* mode binds to
  127.0.0.1 for use behind a tunnel, so nothing is exposed on the LAN.
- End-to-end authenticated encryption between phone and desktop (section 2), independent of
  TLS. Pairing needs physical access to the desktop screen (QR) plus a click on **Allow**.
- No reusable bearer secret goes over the wire; a stolen network capture cannot be replayed.
- Method whitelist on the desktop; the phone can only list, load, start, prompt, cancel,
  answer permissions and request focus.
- Device keys are kept in the OS keychain on the desktop and in app storage on the phone;
  revoke from the desktop at any time.
- Not yet done: per-device scopes (read-only), biometric unlock for approvals, audit log,
  rate limiting, push relay (M5/M6).

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
