# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
node "$(dirname "$0")/decision-annotations.mjs"
node "$(dirname "$0")/human-email.mjs"
node "$(dirname "$0")/decision-annotations-negative.mjs"
node --test "$(dirname "$0")/trusted-tests.mjs"
node --test "$(dirname "$0")/captures.mjs"
node "$(dirname "$0")/mutations.mjs" "$@"
node "$(dirname "$0")/hardening.mjs"
node "$(dirname "$0")/import-snapshot.mjs"
exec node "$(dirname "$0")/ordered-independent.mjs"
