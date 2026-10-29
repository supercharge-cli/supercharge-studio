# Supercharge Studio Server

A small headless daemon for VMs and servers. It puts the Supercharge Studio mobile gateway in front of
`supercharge agent serve`, so you can pair the mobile app with a machine that has no desktop.

It uses the same code as the desktop gateway (`src-tauri/src/gwcrypto.rs`, `gwrelay.rs`):

- end-to-end encryption (HMAC-derived session keys, AES-256-GCM frames, replay protection);
- single-use pairing links that expire after 120s;
- an optional outbound relay, so phones can reach a host behind NAT. The relay only ever sees ciphertext.

## Install

Download `supercharge-studio-server-<platform>` (`linux-x86_64`, `linux-arm64`, `macos-arm64`, `windows-x64.exe`) from the GitHub Release, or build it:

```sh
cd server && cargo build --release   # target/release/supercharge-studio-server
```

## Run

```sh
# attach to an agent that is already running
supercharge-studio-server run --agent ws://127.0.0.1:2419 --agent-secret "$SECRET"
# or start the agent ourselves (uses `supercharge` on PATH, or $SUPERCHARGE_BIN)
supercharge-studio-server run --spawn-agent
# add the relay for phones that cannot reach the host directly
supercharge-studio-server run --spawn-agent --relay wss://relay.example.com
```

| Flag | Env | Default |
|---|---|---|
| `--bind` | `SCS_BIND` | `0.0.0.0:2420` |
| `--public-url` (URL that phones dial) | `SCS_PUBLIC_URL` | derived from bind |
| `--agent` | `SCS_AGENT` | `ws://127.0.0.1:2419` |
| `--agent-secret` | `SUPERCHARGE_AGENT_SECRET` | – |
| `--spawn-agent` | `SCS_SPAWN_AGENT=1` | off |
| `--relay` | `SCS_RELAY` | off |
| `--data-dir` | `SCS_DATA` | `~/.config/supercharge-studio-server` |
| `--name` | `SCS_NAME` | hostname |
| `--control` (local admin socket) | `SCS_CONTROL` | `127.0.0.1:2422` |
| `--no-crash-reports` | `SCS_CRASH_REPORTS=0` | crash reports on (official builds only) |

State (paired device keys, relay host token) lives in `state.json` in the data dir, with mode 0600.

Official builds send scrubbed crash reports (no usage stats); `DO_NOT_TRACK=1` also turns them off.
See [PRIVACY.md](PRIVACY.md) for exactly what is sent.

## Pairing

Run this in a second terminal on the same host:

```sh
supercharge-studio-server pair          # prints a terminal QR + link, asks to approve each request
supercharge-studio-server pair --yes    # approve automatically
supercharge-studio-server devices       # list paired devices
supercharge-studio-server revoke <id>
```

In the mobile app, tap **Scan QR code**, or open/paste the link.

## systemd

Install the binary and `server/dist/supercharge-studio-server.service`, then run
`systemctl enable --now supercharge-studio-server`. The service stores its state in
`/var/lib/supercharge-studio-server`. Set the same `SCS_DATA` (or pass `--data-dir`) when you run `pair`.

## Docker

```sh
docker build -f server/Dockerfile -t supercharge-studio-server .
docker run -d -p 2420:2420 -v scs:/data -e SCS_AGENT=ws://host.docker.internal:2419 \
  -e SUPERCHARGE_AGENT_SECRET=... supercharge-studio-server
docker exec -it <container> supercharge-studio-server pair
```

## Scope

The bridge forwards only the ACP methods the mobile app uses (an allow-list). Anything else
gets `-32601`. Every paired device gets its own agent connection.
