#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# demo/run.sh [verify|followup|experiment|revise|combined] [options]: run the storyline, verify a published human decision,
# open the follow-up task whose agent is briefed with earlier decisions, give each sandbox agent a revision turn,
# run the combined-with-main storyline (two tasks; the second is tested combined with the first once it lands),
# or import a real repository (init) and put several agents on one of its tasks (task).
case "${1:-}" in verify|followup|experiment|revise|combined|init|task) action=$1; shift; exec node "$root/lib/harness.mjs" "$action" "$@";; esac
exec node "$root/lib/harness.mjs" run "$@"
