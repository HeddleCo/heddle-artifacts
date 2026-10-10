# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
exec node "$(dirname "$0")/mutations.mjs" "$@"
