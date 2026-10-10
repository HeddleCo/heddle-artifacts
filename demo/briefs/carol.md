<!-- SPDX-License-Identifier: Apache-2.0 -->
# carol: docs-readme

Improve README.md with runnable parseRow/parseTable examples, installation, edge cases and test instructions. Work only on README.md. Leave the parser unchanged.

Run `npm ci && npm test`, then commit and `git push origin HEAD:main`.
Do not wait for another agent or call the platform control API.

## Rules common to all tracks

Work only in your own clone and lane. Use plain Git to push `HEAD:main` to `origin`;
`upstream` is read-only. Never merge, approve or close platform PRs, force-push, or
edit other agents' work. Do not edit heddle, weft, api, or infrastructure. No weft
imports, URLs or biscuits. Every source file carries Apache-2.0 SPDX. Never print,
commit or paste tokens. Credentials stay in local Git headers; do not show config
on camera. Run tests and report exact output; demonstrate the new test fails on
the base. If blocked, report the exact cause; use only a named fallback.
