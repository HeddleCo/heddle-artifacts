<!-- SPDX-License-Identifier: Apache-2.0 -->
# Live Artifacts compatibility observations

October 10, 2026. These are bounded synthetic acceptance attempts, not performance
benchmarks or proof of a deployed Heddle Worker/Container application.

## A1: transport failure, cleaned

The first attempt stopped at a generic Git transport failure. A credential-free
probe reproduced missing DNS/proxy transport in the sanitized subprocess. The
cloud executor requires an explicitly validated, per-execution loopback proxy
and pinned public CA. That narrow fix retained TLS verification, exact-repository
credential scoping, no redirects and private credential handling. Its independent
review passed 49 tests and the complete dev suite passed 52 tests.

All temporary resources and the three Git tokens actually created were cleaned.
The approved `heddle-demo` namespace was retained, empty.

## A2: real service rejects atomic push, cleaned

Run interval: 21:43:51.900–21:45:42.147 UTC (110.247 seconds, including setup and
cleanup). This failed-run interval is not a successful Git latency measurement.

Completed against Cloudflare Artifacts:

- `git push <canonical> HEAD:main`
- Repository fork and bounded repo-scoped Git-token creation
- `git push <canonical> HEAD:refs/heads/candidates/x/y`
- `git push <canonical> refs/notes/heddle-why`

The next command attempted a candidate and notes update using `git push --atomic`.
The service rejected it as unsupported. Publication stopped; no unchecked
non-atomic fallback was performed.

Not reached: clone/fetch, exact remote-OID readback, final ref verification,
rebuilt-notes compatibility, or Queue event consumption. Successful push
acknowledgements must not be described as an independently verified live
clone/roundtrip result.

Both temporary repositories, their five Git tokens, the Queue, consumer and event
subscription were cleaned. Independent account reads confirmed an empty retained
namespace and no test Queue/subscription. Existing account resources were unchanged.
There were no pending operations or cleanup failures.

## Revised acceptance

The replacement protocol is explicit: stage an immutable proof snapshot, verify
exact refs, then advance only main with its expected-old lease. Partial auxiliary
refs can remain visible while a publication is pending; clients resolve the
snapshot matching their exact main. There is no all-refs-atomic claim.

See [SMOKE.md](SMOKE.md) for the separately reviewed version-2 plan and seven-command
capability probe. It adds a stale-CAS rejection, fresh mirror clone, strict fsck,
exact history/tree/note checks, final remote readback and exact-main Queue event
correlation. Local protocol/recovery tests do not imply a live pass. Updated
results must state the actual completed commands and retain failed observations.

Future timing records use monotonic elapsed milliseconds per Git and REST phase,
identify connector-dispatch overhead, preserve expected rejection outcomes, and
record fixture sizes plus fresh-process status. A single bounded run is one
observation, not p50/p95 or a general repository-scale benchmark. This fixture
contains no native Heddle export/projection phase.

## A3: revised live transport acceptance passed and cleaned

Run interval: 22:02:42.942–22:05:22.746 UTC. All seven Git network commands
completed with their intended outcome. The deliberately stale lease was rejected;
it remains a failed-command observation marked as expected, not a successful push.

The run proved exact pending proof OIDs, main's expected-old update, a fresh mirror
clone with strict fsck, the four-commit main history, unchanged README trees,
exact candidate/main/notes/manifest readback, and delivery/acknowledgement of the
Queue event matching the exact before/after main IDs. The landed synthetic main
was `aff2629c7e5e58c0a34669d62d85afdc53f482a6`.

Observed command elapsed times, including this cloud executor's secure proxy path:

- Seed push: 5,133.092 ms
- Auxiliary staging: 4,515.184 ms
- Staged-ref readback: 4,374.373 ms
- Main expected-old update: 7,677.275 ms
- Expected stale-lease rejection: 5,463.302 ms
- Fresh mirror clone: 6,464.444 ms
- Final-ref readback: 4,094.533 ms

Total test plus cleanup: 159,806.680 ms. Forty-nine REST/connector attempts
accounted for 120,295.749 ms in aggregate; connector timings include orchestration.
The fixture had 13 reachable objects totaling 2,250 uncompressed object bytes,
a 16-byte README, a 606-byte synthetic manifest and a three-byte agent directory.
These are object sizes, not measured HTTP/TLS wire bytes. Peak memory was not
measured. Every Git client was a fresh process; service cache state was unknown.

The matching Queue event was observed 44,541.287 ms after main CAS started. This
includes clone/readback checks and delayed polling. Its provider event timestamp
was 22:04:09.439 UTC, and observation was 22:04:45.978 UTC; server clock alignment
was not verified. Neither interval is a pure delivery-latency measurement.

Both repos, the Queue, consumer and subscription were deleted, and all five Git
tokens were revoked. Independent reads at 22:05:48 UTC confirmed zero repos in
the retained namespace and absence of the test Queue/subscription. No operations
or cleanup failures remained. The official Wrangler logout then exited successfully,
and its temporary local credential directory was removed and verified absent.
Wrangler does not validate or report the refresh-token revocation HTTP response,
so provider-side OAuth revocation was not independently verified beyond CLI success.

This passes the bounded live transport probe. Its manifest is explicitly a
synthetic capability fixture; full engine snapshot/restart/race behavior remains
separately proven locally. The stale-client lease probe is not a live concurrent
writer-race test. No application Worker, Container, R2 workflow or Workers AI
reviewer was deployed by this run, and no recording was made.

The reviewed production protocol also passed the full local Wrangler/SQLite/R2
and stock native-engine storyline in 36.924 seconds using its documented warm
operator npm cache. That run used fake Artifacts, a stub reviewer and scripted
clients/choice; the earlier empty-cache attempt timed out and is retained as such.
