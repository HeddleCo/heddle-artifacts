<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track C acceptance evidence

[Final local Worker output](worker-green.txt): 9 passed. [Node mock output](node-green.txt): 9 passed.
[Deliberate-regression summary](negative-summary.txt): 12 expected assertion failures, with 9 tests passing before and after restoration.
All runs use Chromium and the local mocks; no deployed Cloudflare/Artifacts or real engine verification is claimed.

| Item | Checks | Proof the check can fail |
|---|---|---|
| C-T1 | pushing board, conflict compare, decided Why | remove [board cards](negative-C-T1-board.txt), [conflict regions](negative-C-T1-conflict.txt), [narrative](negative-C-T1-why.txt) |
| C-T2 | JSONL replay changes cards/tests/landing without reload; events survive delayed snapshots | remove [live reducer](negative-C-T2-replay.txt), [board buffer](negative-C-T2-board-buffer.txt), [compare buffer](negative-C-T2-compare-buffer.txt) |
| C-T3 | exact request, 200/403/409, rationale required, signed human discussion | break [heads](negative-C-T3-heads.txt), [403](negative-C-T3-forbidden.txt), [409 guard](negative-C-T3-stale.txt), [rationale bound](negative-C-T3-rationale.txt), [discussion update](negative-C-T3-discussion.txt) |
| C-T4 | local wrangler static routing, board→compare→keyboard decide→Why, login cookie, themes | remove [Why routing](negative-C-T4-routing.txt) |

Screenshots use a 1280×720 viewport. Compare and Why are full-page captures; those pages scroll.

| Screen | Dark | Light |
|---|---|---|
| Board | [dark](board-dark.png) | [light](board-light.png) |
| Compare | [dark](compare-dark.png) | [light](compare-light.png) |
| Why | [dark](why-dark.png) | [light](why-light.png) |

Owner visual approval remains pending. The verification panel deliberately reports unavailable evidence because §7.2
has no `verify` field. Track A must wire `ui/dist`, SPA paths, and the cookie login handler; switch the local domain types
once its contracts PR lands on main. GitHub currently has no CI checks configured for this PR.
