<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track C: Decision UI

Small Preact/TypeScript app consuming architecture §7.1 and §7.2. All work is contained in `ui/`.

```sh
cd ui
npm ci
npm run typecheck
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
The UI uses same-origin credentials and never persists the operator token in browser storage.
The login form submits URL-encoded `token` to POST `/login`, expecting an HttpOnly cookie and redirect.
Track A owns that authentication handler. Human identities come from the project agents response.
§7.1 types are currently copied verbatim into `src/contracts.ts`, marked `TODO: switch to contracts/`.

**Contract gap:** the §7.2 Why response has no `verify` object, although Track C's scope asks for a verify panel.
The panel reports evidence unavailable and gives local inspection commands. It never fabricates a green result.
Track A/B must agree on a contract extension to show engine verification results. The public Why response also lacks
`canonicalRemote`; signed-in project metadata supplies it, otherwise the copy block uses `<CANONICAL_REMOTE>`.
No tokens appear in URLs. Copy commands prompt for a repo read token without echo.

## Acceptance

```sh
cd ui
npx playwright install chromium
npm test
npm run test:negative
```

Playwright uses `wrangler dev --local` with the mock Worker above, covering real static-assets routing and WebSockets.
It checks fixture screens, replay without navigation, exact decisions (200/403/409), keyboard access, and light/dark screenshots at 1280×720.
Production Worker/engine integration and owner visual approval remain integration checks.
