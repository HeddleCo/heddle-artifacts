# SPDX-License-Identifier: Apache-2.0
# syntax=docker/dockerfile:1.7
FROM rust:1.98-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake pkg-config libssl-dev protobuf-compiler && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build-target \
    CARGO_TARGET_DIR=/build-target cargo install --locked --git https://github.com/HeddleCo/heddle --rev 878fea434d2eed86865c0daf3f3b1ab7da6d2e4f heddle-cli
RUN strip /usr/local/cargo/bin/heddle && cd /usr/local/cargo/bin && sha256sum heddle > heddle.sha256

FROM node:22-trixie-slim AS node
RUN apt-get update && apt-get install -y --no-install-recommends binutils && strip /usr/local/bin/node
FROM debian:trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git zstd tar ca-certificates libssl3t64 libsqlite3-0 libstdc++6 && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 65532 --create-home engine && mkdir /state && chown engine:engine /state
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
COPY --from=build /usr/local/cargo/bin/heddle /usr/local/cargo/bin/heddle.sha256 /usr/local/bin/
RUN cd /usr/local/bin && sha256sum -c heddle.sha256
COPY engine/ /opt/engine/
COPY contracts/ /opt/contracts/
COPY demo/ /opt/demo/
RUN printf '#!/bin/sh\n# SPDX-License-Identifier: Apache-2.0\nexec node /opt/engine/engine.mjs "$@"\n' > /usr/local/bin/engine && chmod 755 /usr/local/bin/engine
# Keep the Debian trixie root filesystem, flattening away build/package caches.
# Core Git transport, notes, merge-tree, tar/zstd and npm need no Perl helpers.
RUN mkdir -p /rootfs/usr/bin /rootfs/usr/lib/git-core /rootfs/usr/local/bin /rootfs/usr/local/lib /rootfs/etc /rootfs/opt /rootfs/tmp /rootfs/state /rootfs/home/engine \
    && cp -a /usr/local/bin/* /rootfs/usr/local/bin/ && cp -a /usr/local/lib/node_modules /rootfs/usr/local/lib/ \
    && cp -a /opt/* /rootfs/opt/ && cp -a /etc/passwd /etc/group /etc/nsswitch.conf /etc/os-release /etc/ssl /rootfs/etc/ \
    && for program in git tar zstd env bash dash sleep sha256sum dirname; do cp /usr/bin/$program /rootfs/usr/bin/; done \
    && cp /usr/lib/git-core/git-remote-http /rootfs/usr/lib/git-core/ \
    && ln -s git-remote-http /rootfs/usr/lib/git-core/git-remote-https \
    && for helper in git-upload-pack git-receive-pack git-upload-archive; do ln -s /usr/bin/git /rootfs/usr/lib/git-core/$helper; done \
    && ldd /rootfs/usr/bin/* /rootfs/usr/local/bin/node /rootfs/usr/local/bin/heddle /rootfs/usr/lib/git-core/git-remote-http \
       | awk '/=>|ld-linux/ { for (i=1;i<=NF;i++) if ($i ~ /^\//) print $i }' | sort -u \
       | xargs -I '{}' cp -L --parents '{}' /rootfs/ \
    && ln -s usr/bin /rootfs/bin && ln -s /usr/bin/dash /rootfs/usr/bin/sh \
    && chmod 1777 /rootfs/tmp && chown -R 65532:65532 /rootfs/state /rootfs/home/engine
FROM scratch
COPY --from=runtime /rootfs/ /
LABEL org.opencontainers.image.base.name="debian:trixie-slim"
ENV ENGINE_STATE_DIR=/state PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp
USER 65532:65532
WORKDIR /opt/engine
ENTRYPOINT ["engine"]
