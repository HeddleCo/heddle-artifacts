# SPDX-License-Identifier: Apache-2.0
# syntax=docker/dockerfile:1.7
FROM rust:1.98-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake pkg-config libssl-dev protobuf-compiler && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build-target \
    CARGO_TARGET_DIR=/build-target cargo install --locked --git https://github.com/HeddleCo/heddle --rev 878fea43 heddle-cli
RUN strip /usr/local/cargo/bin/heddle && cd /usr/local/cargo/bin && sha256sum heddle > heddle.sha256

FROM node:22-trixie-slim AS node
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git zstd tar ca-certificates libssl3t64 libsqlite3-0 libstdc++6 && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 65532 --create-home engine && mkdir /state && chown engine:engine /state
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
COPY --from=build /usr/local/cargo/bin/heddle /usr/local/cargo/bin/heddle.sha256 /usr/local/bin/
RUN cd /usr/local/bin && sha256sum -c heddle.sha256
COPY engine/ /opt/engine/
RUN printf '#!/bin/sh\n# SPDX-License-Identifier: Apache-2.0\nexec node /opt/engine/engine.mjs "$@"\n' > /usr/local/bin/engine && chmod 755 /usr/local/bin/engine
ENV ENGINE_STATE_DIR=/state
USER 65532:65532
WORKDIR /opt/engine
ENTRYPOINT ["engine"]
