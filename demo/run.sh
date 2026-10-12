#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# demo/run.sh [verify] [options]: run the storyline, or verify a published human decision.
if [ "${1:-}" = verify ]; then shift; exec node "$root/lib/harness.mjs" verify "$@"; fi
exec node "$root/lib/harness.mjs" run "$@"
