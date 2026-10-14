<!-- SPDX-License-Identifier: Apache-2.0 -->

The `after-*` screenshots were refreshed at 1280×720 in both themes on 2026-10-14 after removing
notice and annotation accent stripes (#64 follow-up). Historical `before-*` images are unchanged.
See the [follow-up evidence](../tapestry-elements/README.md#follow-up-no-accent-stripes-2026-10-14).

# Read-only task pages (#62)

Local Wrangler mock, 1280×720, decided `parser-escapes`, rejected WebSocket handshakes.
The four new images deliberately document this fix; existing film evidence is unchanged.

| Theme | Before (app.tsx from ad102f7) | After |
| --- | --- | --- |
| Light | [before-light.png](before-light.png) | [after-light.png](after-light.png) |
| Dark | [before-dark.png](before-dark.png) | [after-dark.png](after-dark.png) |

The new `read-only.spec.ts` visits every task in the decided, conflict and pushing fixtures
in both themes. It checks that the decision area remains rendered and blocked, while no
`.notice.warning` appears after failed feed connections. It also checks all five focused
fragment sections have no outline and interactive controls retain their keyboard outlines.
The existing C-T8 disconnect/reconnect browser case explicitly checks the stale warning
and disabled rationale after an opened feed drops. Handler tests cover feed rejection both
before and after snapshot hydration, plus a same-turn submit after a real disconnect.

For the negative proof, only `ui/src/app.tsx` was temporarily replaced with the version from
`ad102f7`; the tests and mock rejection control stayed in place. Both read-only handler tests
failed with `1 !== 0`, and both browser theme cases failed with `.notice.warning`:
`Expected: 0`, `Received: 1`. The fixed file was restored byte-for-byte before the final suite.
Actual command output is pasted in the PR.

Capture these images on demand with `STALE_STATE_EVIDENCE_PREFIX=before|after` and
`UI_SCREENSHOT_DIR=<directory>` when running the read-only browser tests.
