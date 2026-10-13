# Supercharge Studio reference relay

A small, blind WebSocket relay for phones that cannot reach a host (desktop app or
`supercharge-studio-server`) directly, for example because the host is behind NAT. Hosts dial
**out** to the relay, so no inbound port is needed. Every frame is already end-to-end encrypted
by the gateway (AES-256-GCM), so the relay only pipes ciphertext. It cannot read or forge traffic;
the most it can do is drop it.

The protocol is described in [docs/MOBILE-PLAN.md](../docs/MOBILE-PLAN.md#relay-server-spec-lightweight-stateless-200-lines).

## Run

See **[docs/RELAY.md](../docs/RELAY.md)** for Docker / Compose (with optional automatic HTTPS
via Caddy), every setting, limits and health checks.

```sh
cd relay && npm install && PORT=8080 node server.mjs
docker compose up -d                                   # plain, :8080
RELAY_DOMAIN=relay.example.com docker compose --profile tls up -d   # with HTTPS
```

## Tests

- `tests/relay.test.ts` (unit): host offline, TOFU binding, bad token, piping, per-IP caps, rate limits, health and stats auth.
- `e2e/mobile.spec.ts` (phone ↔ relay ↔ gateway): the direct URL is unreachable, and the test
  asserts that the relay never saw plaintext.
- `e2e/server.spec.ts`: the same path against the real Rust server.
