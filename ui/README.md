<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track C: Decision UI

Small Preact/TypeScript app consuming architecture §7.1 and §7.2. All work is contained in `ui/`.

```sh
cd ui
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run dev
# http://127.0.0.1:4173/p/demo
```

Routes: `/p/:p`, `/p/:p/t/:t`, `/p/:p/why/:sha`, `/login`.
The fixture project is `demo`; its Why SHA is forty `f` characters.
`UI_FIXTURE=pushing|conflict|decided npm run dev` chooses initial data.
`POST /__mock/reset {"fixture":"pushing"}` resets data; `POST /__mock/replay` streams `fixtures/feed.jsonl`.
Mock controls exist only in the local test harness. No production Worker imports these files.

## Worker integration

Build first. Track A should point Workers Static Assets to `ui/dist` with
`not_found_handling: "single-page-application"`; send `/api/*` and POST `/login` to the Worker.
A recorded decision with no complete `mainSha` is shown as publication pending. Its signed choice, decider
and rationale remain immutable; retry reuses those exact values and the current reviewed heads through the
existing decision endpoint. Only a complete 40-character Git SHA enables landed wording and Why links.
After a failed decision response, the UI re-reads the task before permitting another choice or publication retry.

The UI uses same-origin credentials and never persists the operator token in browser storage.
The login form submits URL-encoded `token` to POST `/login`, expecting an HttpOnly cookie and redirect.
Track A owns that authentication handler. Human identities come from the project agents response.
Domain types are imported directly from `../contracts/types.ts`; no local contract copy is maintained.

The Why HTTP envelope accepts optional `verify: { sha, exportRoundTrip, treeMatch, fsck, checkedAt }`.
Track A stores this per exact published SHA. The panel only uses evidence matching both the requested SHA
and the Why response SHA, with complete boolean checks and a valid timestamp. All three checks must pass
for the recorded publication result to be green. Failed checks remain visible; absent, malformed or mismatched
evidence retains the unavailable panel. This is recorded publication-time evidence, not a live Artifacts recheck,
and does not establish candidate SHA preservation. The public Why response also lacks `canonicalRemote`;
signed-in project metadata supplies it, otherwise the copy block uses `<CANONICAL_REMOTE>`.
No tokens appear in URLs. Copy commands prompt for a repo read token without echo.

## Acceptance

```sh
cd ui
npx playwright install chromium
npm test
npm run test:negative
# Optional: use an installed Chromium instead of a Playwright browser download
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm test
```

Playwright uses `wrangler dev --local` with the mock Worker above, covering real static-assets routing and WebSockets.
It checks fixture screens, replay without navigation, exact decisions (200/403/409), keyboard access, and light/dark screenshots at 1280×720.
It also covers recorded verification pass/fail/mismatched/malformed data, repeated submit prevention, reply cancellation, Back/Forward navigation, and recovery from failed or pending publication.
Six decision-state and server-rendered notice checks cover immutable retries and correct published/pending wording.
Seven unit tests independently reject missing, mismatched, malformed and failed verification evidence;
seven in-process fixture contract/reducer tests cover board shape, exact heads, discussion and live-event updates.
Run `node test/verification-negative.mjs` for isolated SHA-binding, boolean-shape and failed-check mutations.
Run `node test/decision-negative.mjs` for published-SHA gating, immutable-retry and current-heads mutation proof.
Production Worker/engine integration and owner visual approval remain integration checks.

The sandbox has a read-only home configuration directory. Run Wrangler with
`XDG_CONFIG_HOME=/tmp/heddle-c-config WRANGLER_SEND_METRICS=false` there (the Playwright harness already does this).
For browser downloads in the sandbox, set `PLAYWRIGHT_BROWSERS_PATH=/runner/heddleco-build/scratch/heddle-artifacts-C-target/browsers`
for both `npx playwright install chromium` and the test commands. On other machines the default Playwright cache is fine.

`test:negative` starts its own Wrangler harness on loopback port 8790, verifies a green baseline,
removes board/conflict/narrative rendering, live events, decision heads, forbidden/stale handling,
the rationale bound, discussion updates and Why routing one at a time, and requires the matching
browser assertion to fail. It restores the source and reruns all acceptance checks even when a mutation fails.
Do not run another UI build/test or edit `src/app.tsx`/`src/api.ts` concurrently with this script.
Set `UI_NEGATIVE_EVIDENCE_DIR` to a separate relative output directory when preserving earlier transcripts.
Exact transcripts live in `evidence/`; screenshots are generated at a 1280×720 viewport, with full-page
captures for the compare and Why pages. Browser evidence covers the local mock, not deployed Artifacts.

Assets use a restrictive same-origin CSP and do not load remote scripts or fonts. Diff and narrative
content are rendered as text. The directory-match badge compares public keys; it is not a cryptographic
signature verification claim. Reconnection marks compare data stale; refresh explicitly before landing.

Cloudflare routing references: [Workers SPA assets](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
and [Wrangler local development](https://developers.cloudflare.com/workers/wrangler/commands/#dev).
