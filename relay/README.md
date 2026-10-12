# Supercharge Studio reference relay

A small, blind WebSocket relay for phones that cannot reach a host (desktop app or
`supercharge-studio-server`) directly, for example because the host is behind NAT. Hosts dial
**out** to the relay, so no inbound port is needed. Every frame is already end-to-end encrypted
by the gateway (AES-256-GCM), so the relay only pipes ciphertext. It cannot read or forge traffic;
the most it can do is drop it.

The protocol is described in [docs/MOBILE-PLAN.md](../docs/MOBILE-PLAN.md#relay-server-spec-lightweight-stateless-200-lines).

## Run

```sh
cd relay && npm install && PORT=8080 node server.mjs
# or
docker build -t supercharge-studio-relay relay
docker run -d -p 8080:8080 -v relay-data:/data supercharge-studio-relay
```

Put TLS in front of it (any reverse proxy), then enter `wss://your-relay` as the **Relay** in
Settings → Devices, or pass `--relay wss://your-relay` to the server.

| Env | Meaning |
|---|---|
| `PORT` / `HOST` | listen address (default `0.0.0.0:8080`) |
| `RELAY_DATA` | JSON file that keeps the `hostId → sha256(token)` bindings across restarts (`/data/bindings.json` in Docker) |

The relay serves `GET /healthz` and `GET /v1/stats` (counters only: hosts, lanes, frames, bytes).

## Tests

- `tests/relay.test.ts` (unit): host offline, TOFU binding, bad token, piping.
- `e2e/mobile.spec.ts` (phone ↔ relay ↔ gateway): the direct URL is unreachable, and the test
  asserts that the relay never saw plaintext.
- `e2e/server.spec.ts`: the same path against the real Rust server.
