<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track D acceptance evidence

These are exact captured command outputs, not deployed acceptance claims.

| Item | Command and result | Boundary / negative proof |
| --- | --- | --- |
| D-T1 | `node --test demo/test/storyline.test.mjs`: two resets and complete scripted takes in 2.2 s / 1.8 s (zero think delay). README container take uses the normal eight-second delay. | Local smart-HTTP contract mock, fixture Heddle keys/states. **Deployed URL check pending.** Removing conflicts/notes and injecting stale heads/failing tests rejects at the precise guards. See `storyline.txt`. |
| D-T2 | `npm test --prefix reviewer -- --reporter=verbose`, `npm run check --prefix reviewer`, `node demo/test/reviewer-mutations.mjs`: 16 tests pass, three fixtures and forced AI failure included. | Independent Ajv schema validation. Isolated mutations bypassing validation, removing fallback label or retries fail 5 / 10 / 8 tests. See `reviewer.txt`. |
| D-T3 | `node demo/test/clean-container.mjs`: clean `node:22-bookworm-slim` installs Git, clones a private local source mirror and executes README Try it through notes in 35 s. | Fresh container, no npm packages or Heddle preinstalled; localhost contract mock is the server. `MOCK_MUTATION=notes node demo/test/clean-container.mjs` exits 1 at missing chosen/rejected narrative. See both `clean-container*.txt`. |
| D-T4 | `node demo/test/live-local.mjs`: three actual authenticated Codex processes in three tmux panes, each pushed original commits; parser conflict; full local take 114.9 s. | Agents worked concurrently; Git transport timestamps are recorded individually, not claimed to be simultaneous. Fixture engine keys/states/Workers AI response. Terminal transcript in `live-local.txt`; preferred production video still needs Track E recording. The shared conflict/test/notes/stale guards have mutation proof in `storyline.txt`. |
| CLI | `node --test cli/ha.test.mjs`, `node demo/test/cli-mutations.mjs`: 6 tests pass, exact Track A setup header shape included. | Keeping duplicate headers fails 2 tests; removing URL credential guard fails 1. See `cli.txt`. |
| Seed | `npm test --prefix demo/seed-project`, `npm run check --prefix demo/seed-project`, `node demo/test/parser-variants.mjs`: 14 baseline tests, Bob 18/18. | Escapes suite on unchanged base fails 4; Alice fails 3. See `seed.txt`. |

Cloudflare AI type compatibility was checked with the published
`@cloudflare/workers-types@5.20261010.1` in a temporary directory: assigning real
`{AI: Ai}` to `createReviewer` passes strict `tsc --noEmit`. No remote model call
was made; recheck the code-model pin Sunday and exercise the real binding after deploy.

Required integration: land contracts PR #1 and switch `reviewer/types.local.ts`;
Track A wires `env.REVIEW ??= {review:createReviewer(env)}` inside ProjectDO;
Track B seeds from `demo/seed-project` and installs Vitest in each fresh lane;
Track A/E supplies `DEMO_RESET_COMMAND` cleanup (the API has no DELETE);
rehearse twice on Artifacts and record the final UX/video take.
