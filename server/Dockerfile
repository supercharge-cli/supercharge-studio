# Supercharge Studio Server. Build from the repository root:
#   docker build -f server/Dockerfile -t supercharge-studio-server .
FROM rust:1-slim AS build
WORKDIR /src
COPY src-tauri/src/gwcrypto.rs src-tauri/src/gwrelay.rs src-tauri/src/
COPY server/Cargo.toml server/Cargo.lock server/
COPY server/src server/src
RUN cd server && cargo build --release --locked

FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --home-dir /data scs
COPY --from=build /src/server/target/release/supercharge-studio-server /usr/local/bin/
USER scs
ENV SCS_DATA=/data SCS_BIND=0.0.0.0:2420 SCS_CONTROL=127.0.0.1:2422
VOLUME /data
EXPOSE 2420
# Point SCS_AGENT at your `supercharge agent serve` (and set SUPERCHARGE_AGENT_SECRET),
# or install the supercharge CLI in a derived image and set SCS_SPAWN_AGENT=1.
ENTRYPOINT ["supercharge-studio-server"]
CMD ["run"]
