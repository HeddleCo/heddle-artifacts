<!-- SPDX-License-Identifier: Apache-2.0 -->
# Tapestry component evidence (#64)

Original Preact/CSS implementation from the supplied images; no private tapestry source was accessed.
All screenshots use this repository's **local Wrangler mock**, with public test fixture data extended
by `ui/test/tapestry-elements.spec.ts` to exercise three annotation kinds, consecutive agent/human
turns, symbol scope, tags, and the reviewer model. Capture facts use the mock's actual agent records.
A signing key is displayed without a verification tick; this UI does not verify capture signatures.

## 1280×720 film viewport

| Surface | Before light | After light | Before dark | After dark |
| --- | --- | --- | --- | --- |
| Discussion | [before](before-discussion-1280x720-light.png) | [after](discussion-1280x720-light.png) | [before](before-discussion-1280x720-dark.png) | [after](discussion-1280x720-dark.png) |
| Context | [before](before-context-1280x720-light.png) | [after](context-1280x720-light.png) | [before](before-context-1280x720-dark.png) | [after](context-1280x720-dark.png) |
| Reviews | [before](before-reviewer-1280x720-light.png) | [after](reviewer-1280x720-light.png) | [before](before-reviewer-1280x720-dark.png) | [after](reviewer-1280x720-dark.png) |
| Selected capture | [before](before-capture-1280x720-light.png) | [after](capture-1280x720-light.png) | [before](before-capture-1280x720-dark.png) | [after](capture-1280x720-dark.png) |
| Landed reason | [before](before-landed-reason-1280x720-light.png) | [after](landed-reason-1280x720-light.png) | [before](before-landed-reason-1280x720-dark.png) | [after](landed-reason-1280x720-dark.png) |
| Why reason | [before](before-why-reason-1280x720-light.png) | [after](why-reason-1280x720-light.png) | [before](before-why-reason-1280x720-dark.png) | [after](why-reason-1280x720-dark.png) |

Before images use `app.tsx`, `decision-notice.tsx`, `captures.tsx` and `style.css` from base `5b96518`,
temporarily built in this worktree against the same extended mock data. Fixed sources were restored
byte-for-byte. The temporary baseline mock on port 18764 was stopped after screenshots.

## 1440×900

| Surface | Light | Dark |
| --- | --- | --- |
| Discussion | [image](discussion-1440x900-light.png) | [image](discussion-1440x900-dark.png) |
| Context | [image](context-1440x900-light.png) | [image](context-1440x900-dark.png) |
| Reviews | [image](reviewer-1440x900-light.png) | [image](reviewer-1440x900-dark.png) |
| Selected capture | [image](capture-1440x900-light.png) | [image](capture-1440x900-dark.png) |
| Landed reason | [image](landed-reason-1440x900-light.png) | [image](landed-reason-1440x900-dark.png) |
| Why reason | [image](why-reason-1440x900-light.png) | [image](why-reason-1440x900-dark.png) |

## Verification

- UI: `npm ci`, `npm run typecheck`, `npm run test:unit`: exit 0; **61 unit tests passed**.
  [Install](ui-install.txt), [typecheck](ui-typecheck.txt), [unit output](ui-unit.txt).
- UI: `CI=1 UI_SCREENSHOT_DIR=/tmp/heddle-64-existing-screens TAPESTRY_EVIDENCE_DIR=evidence/tapestry-elements npm test`
  (invoked from root with `--prefix ui`): exit 0; **45 browser tests passed**.
  [Full output](playwright.txt). Port 8788 was free before the suite started its own mock.
- Root: `npm ci`, `npm run typecheck`,
  `XDG_CONFIG_HOME=/tmp/heddle-64-root WRANGLER_SEND_METRICS=false npm test`: exit 0;
  **19 worker files / 166 tests passed; 99 harness tests passed, 3 skipped**, on the first run.
  [Install](root-install.txt), [typecheck](root-typecheck.txt), [full tests](root-tests.txt).
  The reported worker flake did not occur. Passing runs retain Workerd's nonfatal diagnostics.
- Negative proof: reverted the annotation symbol markup to the old raw scope text, then ran
  `CI=1 npm test --prefix ui -- test/tapestry-elements.spec.ts --grep '1280x720, light'`.
  Exit **1**: expected `◆ parseRow`, received `symbol:parseRow`. Restored the fixed component
  byte-for-byte before the final passing browser suite. [Real failure output](symbol-negative.txt).

Only existing markup-specific assertions changed: `acceptance.spec.ts` now checks the path and
symbol chip separately and reads the anchor from its chip title; its tag lookup follows the card
rather than the former `li`. `captures.spec.ts` checks the same test results in the attribution card
instead of the old `Tests:` paragraph. No behavior assertions were removed.

Six new browser cases cover all four surfaces at both desktop sizes/themes, missing optional fields,
absent anchors, raw model IDs, mobile stacking at 390×844, keyboard focus and reply threading.
The existing live-update, publication retry, read-only, decision-label and capture-navigation tests
also pass. Screenshot generation waits for fonts and fragment layout to settle.

Regenerate the after images from `ui/` with:

```bash
CI=1 TAPESTRY_EVIDENCE_DIR=evidence/tapestry-elements npm test -- test/tapestry-elements.spec.ts
```
