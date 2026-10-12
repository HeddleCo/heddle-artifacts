# SPDX-License-Identifier: Apache-2.0
FROM node:24-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates git coreutils && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]
