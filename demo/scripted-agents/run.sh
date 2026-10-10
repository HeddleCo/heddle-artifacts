#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
agent=${1:?agent required}
checkout=${2:?checkout required}
delay=${3:-8}
assets=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
case "$agent" in alice|bob|carol) ;; *) echo 'Unknown scripted agent' >&2; exit 2;; esac
cd -- "$checkout"
# The agent path speaks only Git; enrollment and coordination belong to the harness.
sleep "$delay"
if [[ "$agent" == carol ]]; then
  cp -- "$assets/carol.md" README.md
  git add README.md
  subject='docs: document table parsing with runnable examples'
else
  cp -- "$assets/$agent.ts" src/table.ts
  cp -- "$assets/escapes.test.ts" test/escapes.test.ts
  git add src/table.ts test/escapes.test.ts
  subject="parser: support escaped pipes ($agent)"
fi
GIT_AUTHOR_DATE='2026-10-10T12:00:00Z' GIT_COMMITTER_DATE='2026-10-10T12:00:00Z' \
  git -c user.name="$agent" -c user.email="$agent@demo.heddle.local" \
    commit --quiet -m "$subject" -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
# Silence transport output: an error can include a remote header or URL.
if ! git -c protocol.version=1 push --quiet origin HEAD:main >/dev/null 2>&1; then
  echo "$agent: push failed" >&2; exit 1
fi
echo "$agent pushed $(git rev-parse HEAD)"
