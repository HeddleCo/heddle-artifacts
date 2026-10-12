#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# demo/run.sh [verify|followup|experiment|revise] [options]: run the storyline, verify a published human decision,
# open the follow-up task whose agent is briefed with earlier decisions, or give each sandbox agent a revision turn.
case "${1:-}" in verify|followup|experiment|revise) action=$1; shift; exec node "$root/lib/harness.mjs" "$action" "$@";; esac
exec node "$root/lib/harness.mjs" run "$@"
