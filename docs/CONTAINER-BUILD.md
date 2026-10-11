<!-- SPDX-License-Identifier: Apache-2.0 -->
# Current container result and approved library/genuine-replay follow-up

Status, October 11, 2026: **the latest actual job built and checked the image,
passed the complete native suite, then failed the reviewed dependency fixture.
The guarded export correctly retained no image artifacts.** A minimal runtime
library repair is validated in a separate local reproduction and independently
reviewed. The owner has approved this exact follow-up, including the two exact
already-reviewed genuine candidate fixtures, and **one third actual job** under
the US$1 limit. At this source freeze, publication and that job are still pending;
no successful rebuilt image or artifact handoff is claimed.

## Latest actual CI evidence

[Run 38096013643](https://github.com/HeddleCo/heddle-artifacts/actions/runs/38096013643),
[job 114341948595](https://github.com/HeddleCo/heddle-artifacts/actions/runs/38096013643/job/114341948595),
at source `1fdd24eaf9fb34173ba966653a15a9ae14b867e2`, tree
`2a471b1ae19ffd67e6d77c017878854db7a02597`, attempt 1, completed failed at
00:11:01 UTC on October 11:

- The production image built in **26 minutes 18 seconds**, measuring
  **237,172,298 bytes**, below 400,000,000 bytes. Its Docker config ID was
  `sha256:d04c185c2fd1a922cd74b73864037efa9b046f8202bf7c20d8c8ea4ddcefe87e`.
  This is not a published registry manifest digest.
- Exact source/sole-parent/first-attempt checks, anonymous pinned upstream fetch,
  selftest, wrong-version rejection, binary checksum, UID/GID `65532:65532`, and
  production-content exclusions passed.
- The complete in-image native step passed in 48 seconds: 26 trusted-execution
  tests, B-T1–B-T6 baselines/mutations, fork/replay checks, publication recovery
  and fork-advancement races, and all 20 independent ordered-publication cases.
  These overlapping coverage labels must not be summed as disjoint test counts.
- The separate reviewed dependency step failed after three seconds.
  `engine/test/vitest.mjs:21` expected the positive fixture to pass, but Rolldown
  startup reported that its native binding could not load, followed by missing
  WASI fallback-module messages. The abbreviated CI log did not expose the full
  underlying GNU-loader error. The later deliberate-negative and unknown-tree
  dependency assertions were not reached in that job.
- Export, all 16 possible part uploads, upload verification and manifest upload
  were skipped. The artifact API returned **zero artifacts**. No image handoff
  exists to download, import or deploy.
- The job lasted 27m24s; GitHub reported 27m28s workflow runtime. Its timing API
  reported one Ubuntu job and zero billable milliseconds. That is not an
  independent invoice or remaining-account-allowance verification.

The previous actual [run 38091165407](https://github.com/HeddleCo/heddle-artifacts/actions/runs/38091165407)
at `6c08b3654425831008feedd458f760c6301ba6ce` built a different image config ID
with the same measured byte size, then failed because a synthetic bare Git
fixture assumed `hooks/` existed. The two fixture setup repairs were included in
the latest run and its complete native step passed. The earlier
[record 38090841378](https://github.com/HeddleCo/heddle-artifacts/actions/runs/38090841378)
failed workflow validation with no runner job because `runner.temp` was used in
job-level `env`. Keep those records distinct. Both actual-job approvals are
consumed. A separate fresh approval now covers the follow-up described below.

## Minimal library repair and its causal evidence

The minimized image copies startup libraries found by `ldd` on its executables.
The locked public npm fixture also installs GNU native addons that are loaded
later with `dlopen`; their dependencies need not appear in that executable-only
closure. The proposed Dockerfile adds exactly one copy operation:

```sh
cp -L --parents /lib/*-linux-gnu/librt.so.1 /rootfs/
```

Two comments explain the addition. The library repair itself changes no package
install, base image, lockfile, dependency version, npm flag or test. The separately
approved exact genuine-tree allowlist addition is described below.
The copied file is Debian's existing glibc compatibility library; the local
reproduction measured it at **14,552 bytes**. The next actual image's size and
config ID remain unknown until rebuilt and measured.

In a local minimized Debian trixie 13.6/glibc 2.41 rootfs with **Node 24.19.0**,
the exact locked fresh install succeeded, but the original GNU binding load
failed with the full missing `librt.so.1` cause. Adding only that library made:

- Both installed GNU native addons, Rolldown and LightningCSS, load directly.
- The unchanged complete dependency fixture pass its positive case, deliberate
  negative assertion and unknown-tree withholding check.
- All 26 trusted-execution checks pass in the local rootfs, as well as on the host.

Independent ELF review found only those two fixture-native addons, only
`librt.so.1` missing from the original closure, and no unresolved recursive
SONAME dependencies after the addition. The exact reviewed Dockerfile SHA-256 is
`08631087a4b4619eb98ddb47709d76a44aa1c68f02717b07c217f665c92995b7`.

This establishes a causal **local rootfs reproduction**, not execution of the
actual discarded CI image. The actual CI image used **Node 22.23.3**. Its rebuilt
Node 22 image, complete tests and any retained export still require a newly
approved real job, which has not yet run at this freeze. Do not relabel the local
result as image acceptance.

## Approved publication scope: fourteen files

The follow-up is a sole direct child of published integration head
`1fdd24eaf9fb34173ba966653a15a9ae14b867e2`. It contains exactly:

1. The independently cleared eight-file Artifacts binding-contract correction
   from the frozen local v6 checkpoint: `worker/env.ts`, `worker/artifacts.ts`,
   `worker/project-do.ts`, `worker/test/artifacts-binding.test.ts`,
   `dev/memory-artifacts.ts`, `dev/fake-artifacts/binding.mjs`,
   `dev/fake-artifacts/server.mjs`, and `dev/test/fake-artifacts.test.mjs`.
2. The minimal `engine/Dockerfile` library addition.
3. `scripts/generate-trusted-test-trees.mjs`, `demo/trusted-test-trees.json`, and
   the new `engine/test/genuine-reviewed.mjs`, adding only the two exact reviewed
   historical candidate trees and a fail-closed integration test.
4. `.github/workflows/container-build.yml`, changing both fixed-parent guards
   to the current published head and appending the genuine replay invocation
   after unchanged Vitest testing. The combined dependency step gets six minutes
   of orchestration time; individual tests retain their 60-second limits and the
   whole job retains its 60-minute ceiling.
5. This accurate results/follow-up document.

The binding correction aligns `commit.hash` metadata and provider-shaped absence
errors, validates successful metadata, and fails closed on uncertain lookups
before resource creation/enrollment. It is source-only in this image job:
**all eight Worker/dev files remain excluded by the unchanged default-deny
Docker context**. A container job does not substitute for their separate local
Worker tests or direct live binding verification. The eight-file correction is
not part of the preceding actual CI run.

Before any publication, verify the full proposed file manifest, exact parent,
current integration/main heads, and unchanged unrelated files. Use a no-force
expected-head update; never overwrite newer work. Keep draft PR #6 draft.
The owner approved this exact scope separately from the two earlier consumed jobs.

## Exact historical genuine replay, with unknown edits withheld

The original four synthetic manifest entries remain byte-identical. The only
new allowlisted complete-tree SHA-256 values are:

- `genuine-native-scan`: `266e3f9e01bb63cd2f4139b9a225b83557733d656520869f856f8c764c7aff61`.
- `genuine-native-parity`: `d3782809f58026c35839bc7226d1b54e43d46e5fc7f6320a12b9b4b5fdb37287`.

The generator checks the frozen published candidate inputs and expected digests
before writing. Eight adversarial generator cases fail without writing. The
integration test uses the image's default trusted manifest, deliberately clears
operator manifest overrides, checks 56/56 and 70/70 expected test results, and
proves changed source or an extra file in either tree is withheld before an npm
execution witness. The two source trees and all historical signed evidence stay
unchanged and remain excluded from the production image context. The manifest
contains only names and hashes; candidate trees are temporary read-only mounts.

Independent host and repaired-rootfs runs passed both exact candidates and all
four withheld mutations. They used an existing integrity-checked dependency
cache. A cold-cache local stripped-environment attempt exhausted a candidate's
60-second install/test limit; cold CI success is therefore still unverified.
The workflow mounts no cache and makes no new cache persistence exception. The
combined dependency step allows six minutes for four individually bounded test
executions plus overhead, without increasing any individual or whole-job limit.

This is re-execution of previously genuine agent-produced, reviewed source. It
is not new agent coding, a new live reviewer response, or a new human choice.
It does not by itself establish hosted app readiness or a recorded live demo.

## Approved one-job boundary; execution pending

The fresh approval covers these fourteen source files, one new job and its
conditional private image retention together. Limits remain:

- Exactly one standard GitHub-hosted `ubuntu-24.04` job, no matrix, a **60-minute
  whole-job timeout**, and a **US$1 total spending limit** including bounded
  storage. No subsequent job or paid rerun is included.
- No push trigger. The guarded integration PR synchronization is the
  one intended trigger; no extra manual dispatch or reopen. The job allows only
  the same repository's integration branch PR against main. The provided manual
  entry remains subject to separate approval and default-branch availability.
- Checkout selects the exact head SHA with depth 2 and no persisted credentials.
  Preflight verifies repository, source identity, attempt 1 and a sole direct
  parent equal to `1fdd24eaf9fb34173ba966653a15a9ae14b867e2`. The export program
  independently checks that same parent again.
- Job permissions stay `contents: read`. Official checkout/upload actions keep
  their existing full-commit pins. There are no application/Cloudflare/registry
  secrets, OIDC, credentials added, registry login, image push, deployment,
  persistent cache, permission expansion or additional job.

Parent/attempt guards and timeouts are defenses, not an account spending cap.
Reopening the same commit could create another first-attempt workflow record;
never treat that as authorized. Account quota, unused minutes, payment settings
and invoice remain unverified. Do not create credentials or expand permissions
to inspect billing. This job uses its fresh approval; the earlier consumed US$1 approvals are not reused.

## Production build and guarded test procedure

Build from the repository root with the production default-deny `.dockerignore`:

```sh
docker build --pull --progress=plain --file engine/Dockerfile --tag heddle-artifacts-engine:ci .
```

Stock Heddle 0.30.0 is pinned at
`878fea434d2eed86865c0daf3f3b1ab7da6d2e4f`; Cargo's lockfile is respected and the
between-stage binary checksum is checked. Base-image/frontend tags and system
package availability are not immutable, so this is a pinned-source procedure,
not a bit-for-bit image-reproducibility claim.

The job checks a size below 400,000,000 bytes, declared UID/GID `65532:65532`,
selftest, Git-as-Heddle rejection, binary checksum and absence of test/demo
private evidence content. Native tests mount only reviewed `engine/test`
read-only; production engine code, libraries, contracts and trusted-tree manifest
come from the image. They use read-only roots, non-root execution, dropped
capabilities, no-new-privileges, bounded resources and tmpfs scratch. Native
acceptance runs without network. The separate locked reviewed dependency fixture
uses public npm access with isolated HOME/npm configuration and
`npm ci --ignore-scripts`. No lockfile removal, arbitrary-tree authorization or install-script
exception is introduced. The new exact-tree replay runs afterward in a separate
container with only its test file and the two public candidate directories
mounted read-only. Image-owned engine code and the trusted manifest are never
overlaid. Both invocations must succeed before the dependency step can pass.

The reviewed-tree guard remains default-withheld for unknown code. These controls
are not a general untrusted-code sandbox. Neither a successful job nor the local
rootfs reproduction would establish full hosted Worker/Container/R2 operation,
Workers AI review, user browser acceptance or general service latency.

## Unchanged success-only private image handoff

Only after every image/native/dependency/genuine-replay check succeeds may the workflow
save the immutable inspected Docker image ID, gzip its bytes and export:

- At most 16 payload parts of **24 MiB** each and one small manifest artifact.
- At most **384 MiB compressed** and **512 MiB uncompressed** image tar payload.
  ZIP/manifest framing adds small storage overhead; streaming checks enforce the
  payload bounds before producing a usable complete handoff.
- Exactly allowlisted image part/manifest files, **one-day retention**, no
  overwrite, no hidden files, and failure on missing files.
- A final manifest only after every required part upload succeeds with an
  artifact ID and digest. Partial uploads may remain for their one-day retention;
  no partial or non-successful run is a valid handoff.

The official `actions/upload-artifact` v4.6.2 pin remains
`ea165f8d65b6e75b540449e92b4886f43607fa02`. It uses GitHub's existing ephemeral
job authentication; no new user/application credential is supplied. Repository
readers can access these retained code/dependency bytes. This proposal does not
authorize registry publication, Cloudflare upload, import, deployment or public
release.

After this approved run succeeds, verify exact source/parent/tree,
run/attempt, image identity, part names/counts/sizes, manifest and both archive
hashes before consuming a handoff. The manifest hash is written to the job
summary. If the connector cannot expose that summary, an equivalent provenance
chain is to match the exact manifest artifact's ZIP ID/digest to its bounded
upload-step log and authenticated metadata, verify the original ZIP bytes, then
derive the inner manifest hash from those verified bytes. Never bootstrap trust
from a field inside an unverified downloaded manifest. GitHub remains the common
trust authority; this is not an independent attestation.

Use safe ZIP selection with no traversal, duplicate members, symlinks, extras or
oversize expansion. Reconstruction must be bounded and no-clobber, never extract
tar members, import/run an image or contact a registry. The local handoff verifier
must pin this proposal's new expected parent; the earlier verifier's old parent
must not be silently reused. Actual part count, image ID, size, retained storage
and expiry remain unknown until a newly authorized successful job.

## Verification still pending

Local YAML/Bash/context/guard/export regression checks and source manifests are
recorded with this proposed checkpoint. Such checks, the independent ELF review
and the Node 24 rootfs experiment do not replace GitHub workflow acceptance or an
actual rebuilt Node 22 image run. No local Docker daemon is available here.

Still required before claiming completion: guarded publication; the new run's
successful image, native, dependency and genuine replay results; complete private
artifact export; and verified
local handoff bytes. A failed next job must be diagnosed without automatic spend,
source publication or weakened acceptance rules.
