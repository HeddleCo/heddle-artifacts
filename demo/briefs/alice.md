<!-- SPDX-License-Identifier: Apache-2.0 -->
# alice: parser-escapes

Support escaped pipes (\|) in `src/table.ts:parseRow`. Prefer a small regular-expression implementation. Preserve the public `string[]` API. Add regression tests. Work only on parser source and its tests.

Run `npm ci && npm test`, then commit and `git push origin HEAD:main`.
Do not wait for another agent or call the platform control API.

## Rules common to all tracks

Work only in your own clone and lane. Use plain Git to push `HEAD:main` to `origin`;
`upstream` is read-only. Never merge, approve or close platform PRs, force-push, or
edit other agents' work. Do not edit heddle, weft, api, or infrastructure. No weft
imports, URLs or biscuits. Every source file carries Apache-2.0 SPDX. Never print,
commit or paste tokens. Credentials stay in local Git headers; do not show config
on camera. Use only the actual provider/model attribution supplied by the runtime
or operator; omit unknown details. Do not invent a coauthor identity or email.
Run tests and report exact output; demonstrate the new test fails on
the base. If blocked, report the exact cause; use only a named fallback.
