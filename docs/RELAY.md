# Public relay (self-hosted)

The relay lets a phone reach your computer when they are **not on the same network** (mobile
data, another Wi-Fi, a computer behind NAT). The computer dials **out** to the relay, so you never
open a port at home. Anyone can host one relay and share it with any number of people.

**The relay cannot read anything.** Pairing keys live only in the QR code and on the two devices.
Every frame through the relay is the gateway's own handshake plus AES-256-GCM ciphertext; the
relay only forwards bytes between a phone socket and a host socket. A malicious relay can drop
traffic, but it cannot read it, change it or impersonate either side (each side proves the shared
key with an HMAC challenge and every frame is authenticated).

## Quick start (Docker)

```sh
git clone https://github.com/iotserver24/supercharge-studio && cd supercharge-studio/relay
# Automatic HTTPS with Caddy (ports 80 and 443 must reach this machine, DNS must point here):
RELAY_DOMAIN=relay.example.com RELAY_TRUST_PROXY=1 docker compose --profile tls up -d
# …or plain, behind your own TLS proxy / load balancer:
docker compose up -d          # listens on :8080
curl https://relay.example.com/healthz   # {"ok":true,...}
```

Image: `ghcr.io/iotserver24/supercharge-studio-relay` (`latest`, `X.Y.Z`, `X.Y`; amd64 and arm64),
built and published by `.github/workflows/relay-image.yml`. Without Compose:

```sh
docker run -d --name relay --restart unless-stopped -p 8080:8080 -v relay-data:/data \
  ghcr.io/iotserver24/supercharge-studio-relay:latest
```

## Use it

- **Desktop app**: Settings → Devices → *Relay URL* = `wss://relay.example.com`, then *Show
  pairing code*. The status line should say *Relay: online*. Phones try the computer's direct
  addresses first and switch to the relay automatically when none answers (about 3 s per address).
- **Headless server**: `supercharge-studio-server run --relay wss://relay.example.com`
  (or `SCS_RELAY=...`).
- **Phone**: nothing to configure; the relay route is in the pairing code. Phones paired before
  you set a relay need a new code.

If the status says *host id is bound to another key*, someone (or an older install) already
registered this computer's relay ID; click **Use a new relay ID** and show a new code.

## Configuration

All settings are environment variables (put them in `relay/.env` for Compose; see `.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | listen address |
| `RELAY_DATA` | `/data/bindings.json` (Docker) | stores `hostId → sha256(token)` so a host ID can't be taken over after a restart |
| `RELAY_TRUST_PROXY` | `0` | `1` when behind Caddy/nginx: per-IP limits use `X-Forwarded-For` |
| `RELAY_MAX_HOSTS` | `5000` | computers online at once |
| `RELAY_MAX_CONNS` | `20000` | open WebSockets in total |
| `RELAY_MAX_CONNS_PER_IP` | `64` | open WebSockets per client IP |
| `RELAY_CONN_RATE_PER_MIN` | `120` | new WebSockets per IP per minute (HTTP 429 beyond) |
| `RELAY_MAX_LANES_PER_HOST` | `8` | phones connected to one computer at once |
| `RELAY_LANE_BYTES_PER_SEC` | `2097152` | per-direction bandwidth per lane (backpressure, not drops) |
| `RELAY_MAX_FRAME` | `262144` | largest frame in bytes |
| `RELAY_IDLE_SECS` | `120` | close lanes with no traffic (apps send keepalives) |
| `RELAY_ATTACH_SECS` | `10` | how long a phone waits for its computer to attach |
| `RELAY_BINDING_TTL_DAYS` | `90` | forget host IDs not seen for this long |
| `RELAY_MAX_BINDINGS` | `100000` | cap on remembered host IDs (oldest offline ones go first) |
| `RELAY_STATS_TOKEN` | empty | if set, `GET /v1/stats` needs `Authorization: Bearer <token>` |

Endpoints: `GET /healthz` and `/readyz` (JSON: uptime, hosts, lanes, connections; used by the
Docker health check), `GET /v1/stats` (counters only, no IDs or IPs), WebSocket `/v1/host/<id>`,
`/v1/connect/<id>`, `/v1/lane/<id>/<lane>`. The protocol is in
[MOBILE-PLAN.md](MOBILE-PLAN.md).

## Sizing

One relay process handles thousands of idle hosts in well under 256 MB; each live lane costs two
sockets and a small buffer. Logs contain only start-up and errors, never IDs, IPs or payloads.
The container runs as an unprivileged user with a read-only root filesystem, no capabilities and
`no-new-privileges`.

## Verifying it end to end

```sh
# terminal 1: a host on the relay
supercharge-studio-server run --relay ws://127.0.0.1:8080
# terminal 2: pairing code, then a simulated phone that can only use the relay
supercharge-studio-server pair --yes
npx vite-node scripts/phone-sim.ts -- "<code>" --relay-only
```
