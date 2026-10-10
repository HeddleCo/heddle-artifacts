#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run by clean-container.mjs in a fresh Node image; never enable shell tracing.
set -euo pipefail
start=$SECONDS
printf '%s\n' '$ apt-get update && apt-get install git ca-certificates'
apt-get update -qq >/dev/null
apt-get install -y -qq git ca-certificates >/dev/null 2>&1
mkdir /work
cd /work
printf '%s\n' '$ git clone <private local source mirror> heddle-artifacts'
git clone --quiet "$SOURCE_URL" heddle-artifacts
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
cd heddle-artifacts
printf '%s\n' '$ node --version; git --version'
node --version
git --version
printf '%s\n' '$ ./demo/run.sh --mode scripted'
./demo/run.sh --mode scripted
printf '%s\n' '$ node cli/ha.mjs join "$DEMO_URL/p/$DEMO_PROJECT" --task docs-readme --as guest --dir /tmp/heddle-guest'
HA="$PWD/cli/ha.mjs"
node "$HA" join "$DEMO_URL/p/$DEMO_PROJECT" --task docs-readme --as guest --dir /tmp/heddle-guest
cd /tmp/heddle-guest
printf '%s\n' '$ ha status'
node "$HA" status >/dev/null
printf '%s\n' '$ git fetch upstream main +refs/notes/*:refs/notes/*'
git fetch --quiet upstream main '+refs/notes/*:refs/notes/*'
printf '%s\n' '$ git log --notes=heddle* -1 upstream/main'
git log --notes='heddle*' -1 upstream/main
printf '%s\n' '$ ha why $(git rev-parse upstream/main)'
node "$HA" why "$(git rev-parse upstream/main)"
elapsed=$((SECONDS-start))
if (( elapsed >= 600 )); then echo 'FAIL: README exceeded 10 minutes'; exit 1; fi
printf 'PASS D-T3 clean container, local contract mock: %ss to Git notes; no Heddle install.\n' "$elapsed"
