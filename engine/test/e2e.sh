# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
node --test "$(dirname "$0")/trusted-tests.mjs"
node "$(dirname "$0")/mutations.mjs" "$@"
node "$(dirname "$0")/hardening.mjs"
exec node "$(dirname "$0")/ordered-independent.mjs"
