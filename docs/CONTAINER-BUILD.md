<!-- SPDX-License-Identifier: Apache-2.0 -->
# Current container result and approved bounded image handoff

Status, 2026-10-10: **the context repair was published, one actual runner job
built and measured the production image, and the overall run failed in a native
test fixture. A fresh publication/run with bounded private image export is
described below was approved for one job on October 10. At source preparation,
that follow-up has not yet run; its actual result must be read from the new CI receipt.**

[Run 38091165407](https://github.com/HeddleCo/heddle-artifacts/actions/runs/38091165407),
[job 114327720861](https://github.com/HeddleCo/heddle-artifacts/actions/runs/38091165407/job/114327720861),
at source `6c08b3654425831008feedd458f760c6301ba6ce` completed on October 10:

- The production image built in **29 minutes 56 seconds** and measured
  **237,172,298 bytes**, below the 400,000,000-byte cap.
- Image config ID:
  `sha256:db90306668034e6d562a49ccf2dd501c124c3a3a71b9d450be090537b656b0da`.
  This is the Docker config digest, not a published registry manifest digest.
- Source identity, anonymous pinned-upstream access, image selftest,
  wrong-version rejection, binary checksum, UID/GID `65532:65532` and production
  content exclusions passed.
- The native suite reached and passed 26 trusted-execution checks, B-T1–B-T5
  baselines/mutations, B-T6, fork naming and replay binding.
- The hardening fixture then tried to write its synthetic bare repository's
  `hooks/update` without creating `hooks/`. The minimized production image omits
  Git templates. `engine/test/hardening.mjs:93` failed with `ENOENT`.
- Later hardening/recovery/race and independent ordered-publication checks were
  not reached. The separate dependency fixture step was **skipped**. Full
  in-image acceptance is not established.
- No saved image or Actions artifact was retained; no registry image was
  published. The eight-file credential changes and two fixture setup repairs
  remain local and were not part of this tested source.

The earlier [run 38090841378](https://github.com/HeddleCo/heddle-artifacts/actions/runs/38090841378)
for `6a0578e64b52e0b9d8a0df89343f79f6002d51d4` failed workflow validation with
`jobs: []` and `billable: {}`. It allocated no runner. The published two-file
context repair fixed the invalid job-level `runner.temp` expression and led to
the single actual job above. Preserve both records: the zero-job failure and
the later failed test job are different events.

The prior one-actual-job authorization was consumed. The owner approved the
one bounded follow-up below; any additional publication or run requires fresh approval. Historical PR #4's 338,926,309-byte image remains a
separate result. This local executor has no Docker, Podman or BuildKit; local
YAML/shell/synthetic checks are not additional container evidence.

## Approved follow-up scope: twelve files and one job

Review the exact combined delta: eight credential-related files, the two fixture
setup files, `.github/workflows/container-build.yml` and this document, for
**12 repository files total**. No part of that combined delta has been published
by this preparation. Recheck the integration and main heads before publishing.
The proposed commit must have the sole direct parent
`6c08b3654425831008feedd458f760c6301ba6ce`; the workflow checks that relationship
using a two-commit checkout before building. It rejects `GITHUB_RUN_ATTEMPT != 1`.

The owner approved one existing-job run with a **US$1 total limit** on standard
`ubuntu-24.04`, retaining the **60-minute
whole-job timeout**, same-repository integration-branch guards, no push trigger
and no matrix. Any rerun, reopen, manual dispatch or further publication needs
new authority; branch guards and a timeout do not impose an account spending cap.
A same-commit reopen may still start a first-attempt workflow record. Review
account quota; the approved US$1 limit includes compute and this bounded private storage.

After **all** existing image/native/dependency checks succeed, the proposed
workflow saves the immutable inspected image ID, gzips it and exports only
bounded production-image files to the private repository's Actions storage:

- At most 16 payload parts of 24 MiB (25,165,824 bytes) each, each in a separate
  artifact, and one small final manifest artifact: **17 artifacts maximum**.
- At most 384 MiB (402,653,184 bytes) compressed payload and 512 MiB
  (536,870,912 bytes) uncompressed Docker-save tar. Both streaming bounds reject
  excess before publishing a usable handoff. Artifact ZIP framing/manifest add
  small storage overhead to the payload cap.
- Every artifact has **one-day retention**, `overwrite: false`, hidden-file
  exclusion and error-on-missing-file behavior. Repository readers with access
  can download this retained production code/dependency copy.
- Native/dependency test outcomes must both be success. No `always()` or
  `continue-on-error` weakens this gate. The manifest uploads only after every
  required part's upload ID/digest is present and its outcome is successful.
- Failed or partial uploads can leave already-uploaded parts for their one-day
  retention, but no complete manifest handoff. Never consume a partial set or a
  non-successful run.

The actual number of parts cannot be inferred from image byte size; it is
`ceil(actual gzip size / 25,165,824)`, at most 16. Only after a real approved export
will the normal count and precise retained ZIP storage be known.

The official upload action is
[`actions/upload-artifact` v4.6.2](https://github.com/actions/upload-artifact/releases/tag/v4.6.2),
pinned at `ea165f8d65b6e75b540449e92b4886f43607fa02`; its release and pinned action
metadata were verified. The only new network handoff uses that action's normal
GitHub runtime. Existing `contents: read` permissions remain; there are no new
secrets, OIDC, Cloudflare/registry credentials, registry push, cache, deployments,
software installs or extra jobs. Official checkout/upload use GitHub's existing
ephemeral job authentication, not newly supplied user/application credentials.

### Manifest and later import

The manifest binds exact source/parent/tree/upstream commit, run ID/attempt,
image config ID/size/platform/user, passed test statuses, ordered part names,
artifact names, byte sizes and SHA-256 values, plus full compressed and
uncompressed archive hashes/sizes. Its own hash goes to the exact run's summary.
Gzip has no embedded filename and a zero timestamp; sorted-key manifest output
is deterministic for identical bytes and metadata. Separate builds are not
claimed bit-for-bit reproducible.

The Actions connector downloads whole artifact ZIPs, so chunks inside a single
artifact would not bound transfer. Each part is a distinct artifact. Verify
provider ZIP size/digest and exact artifact identity, then safely materialize
only expected basenames into a new staging directory. Reject duplicate ZIP
entries, traversal, symlinks and unexpected files. The available GitHub download
contract itself does not document a universal 32 MiB limit. A separate Sediment
materializer has that limit; use only the route matching the returned file type.
Actual executor-local transfer remains unverified until real artifacts exist.

Before any later import, require caller-trusted reviewed source, parent, run,
attempt, image config ID and manifest hash. Verify exact part count/order/names,
sizes and hashes, both full archive hashes and bounded gzip decoding. Checksums
are not an OIDC attestation. Do not extract or execute container contents merely
to verify the stream. Retention approval does not authorize software install,
registry authentication, image push, credential changes or deployment.

A Docker config ID, image archive SHA-256 and eventual registry manifest digest
identify different objects. The latter must be measured after a separately
approved import and checked against the expected config ID before deployment.
No registry digest or import/push success is claimed here. Pinned Crane v0.22.1
supports a single Docker-save descriptor even with `RepoTags: null`, but expects
the outer input to be raw tar. A later separately approved import must first
stream-decompress the verified transport gzip into a new bounded, hash-checked
tar, without extracting its members. Do not hand the outer gzip directly to
Crane. No Crane software was installed or executed by this preparation.

## Original approval boundary and repair scope

The initial approval covered publication of the reviewed source, draft PR #6 and
one actual build job as described below. The rejected workflow never allocated
that job. The published context repair changed only workflow initialization and this
status document; all other 269 files remained byte/mode-identical. It included
no credential-source changes. That historical boundary does not approve the
new twelve-file publication or image retention described above.

The original actions were:

1. Publish the reviewed integration source to the existing private
   `HeddleCo/heddle-artifacts` repository on `integration/demo-hardening` and open
   a **draft** PR against `main`. Recheck current remote heads before publishing;
   the observed remote main baseline was
   `e1b525ab4e47f5cc02766eefda40355ff5aa0d6a`. The local combined checkout's base
   commit is not a substitute for the final, reviewed remote source SHA.
2. Include `.github/workflows/container-build.yml` and allow the initial
   PR-triggered run on one standard GitHub-hosted `ubuntu-24.04` runner, with a
   **60-minute job timeout**. Review private-account billing/quota first or obtain
   a concrete spending limit. A run can consume billable minutes even if it fails.
3. Retain ordinary GitHub Actions logs and the job summary in this private
   repository. They identify the tested source SHA, local image ID, byte size,
   selftest and synthetic test results. They do not include native state bundles,
   private signing keys, tokens, source archives or a saved container image.

The original approval excluded merge, deployment, image/registry publication,
Actions artifact uploads, new secrets, billing changes, persistent runners and
permission changes. None occurred in the completed run. The next proposal
requests only the bounded private Actions retention described above in addition
to one publication/run; other exclusions remain. Future pushes
can retrigger CI, so approving a first run must not be treated as unlimited
permission to publish revisions or spend on reruns.

### Trigger choice

The initial trigger is `pull_request`, targeting `main`, with the build job
restricted to the **same repository's** `integration/demo-hardening` branch.
It handles `opened`, `synchronize` and `reopened`; unrelated PRs and fork PRs skip
this job. It never uses `pull_request_target` and never attaches secrets.
Publishing/opening the approved draft PR therefore initiates the first run;
there is no separate post-publication pause before CI.

`workflow_dispatch` is also provided for later explicitly approved checks. It
accepts a required full `expected_sha`, verifies that SHA matches the selected
branch's tip, and allows only the integration branch or `main`. GitHub requires
a manually dispatched workflow to exist on the default branch first. Merely
adding it to a draft PR does not make the manual trigger available. Do not merge
or change the default branch just to bypass that restriction. See
[GitHub's manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Execution and permissions

- The sole Actions permission is `contents: read`. GitHub's ephemeral repository
  token is used by the official checkout action, with
  `persist-credentials: false`; no application, Cloudflare, Artifacts, registry or
  user credentials are passed to the build or test containers. No OIDC access is
  requested. The checkout action is
  [v4.2.2](https://github.com/actions/checkout/releases/tag/v4.2.2), pinned at
  `11bd71901bbe5b1630ceea73d27597364c9af683`.
- Checkout selects the PR's exact head SHA, rather than silently building a
  generated merge commit. The job verifies the checked-out SHA and reports it.
- An anonymous Git fetch checks that the exact upstream Heddle commit remains
  available without credentials before attempting the expensive build. It uses
  an empty environment and home, disables Git system/global config, prompting
  and credential helpers, and has a 120-second fetch bound.
- Docker uses a fresh empty configuration directory. The production build is
  exactly `docker build --pull --progress=plain -f engine/Dockerfile -t
  heddle-artifacts-engine:ci .`, from the repository root. No build secret,
  registry login, SSH forwarding, remote cache or image push is configured.
- The production `.dockerignore` remains default-deny and unchanged. Tests,
  Git metadata, environment files, native state, logs, dependencies and demo
  evidence do not enter the build context.
- In the completed baseline run, no upload or persistent cache action was
  present; the image and test state existed only on its disposable runner. The
  proposed next workflow adds only the bounded private image artifacts described
  above. Test state stays temporary. Job logs/summary follow repository access
  and retention policies separately from the one-day image artifact setting.

Build-time network reads include Docker Hub/frontend/base images, Debian package
repositories, GitHub's stock Heddle source and the Rust crate registry. The
separate reviewed dependency fixture accesses the public npm registry. The
native acceptance/mutation container has networking disabled. The build itself
executes reviewed source/dependency build steps; read-only repository permissions
are not a sandbox for arbitrary pull-request code. Owner source review is still
required before publishing this branch and running it.

## What a green run establishes

1. The current production Dockerfile builds from the reported source SHA, using
   stock Heddle 0.30.0 pinned at
   `878fea434d2eed86865c0daf3f3b1ab7da6d2e4f`.
2. The image is strictly below **400,000,000 bytes**, declares UID/GID
   `65532:65532`, passes `selftest`, rejects Git substituted as Heddle, and verifies
   the copied Heddle binary against its generated SHA-256 file. The job asserts
   that test files, demo briefs and captured evidence are absent from the image.
3. `engine/test/e2e.sh` runs **inside that exact image**. This exercises the
   trusted-tree refusal tests, native B-T1–B-T6 baseline and mutation proofs,
   hardening/publication races and independent ordered-publication checks.
4. `engine/test/vitest.mjs` separately verifies locked, explicitly reviewed
   positive/negative dependency fixtures and withholding an unreviewed tree.
   It retains the existing isolated npm config, `npm ci --ignore-scripts`,
   per-candidate 60-second budget and trusted-tree guard.

The tests are mounted using:

```sh
--mount "type=bind,source=$GITHUB_WORKSPACE/engine/test,target=/opt/engine/test,readonly"
```

Only the test directory is overlaid. Production engine code, libraries,
contracts and the shipped trust manifest all come from the image. Each run
uses the image's non-root user, a read-only root filesystem, dropped Linux
capabilities, `no-new-privileges`, bounded PIDs/memory/CPU and fresh writable
tmpfs scratch directories. Test mutation copies are written only to temporary
scratch. Executable scratch is intentional because the existing synthetic tests
create Git hooks and wrapper commands. No host credentials, Docker socket,
engine source overlay or persistent state is mounted.

These controls do not turn the reviewed-fixture gate into a general
untrusted-code sandbox. Do not enroll arbitrary incoming code in the trust
manifest to make the run green. A green run also does not establish deployment,
Cloudflare Container startup, live app correctness, production throughput or the
historical full-runtime Docker size mutation. The latter is a separate optional
build in `engine/test/docker.mjs`, deliberately not part of this bounded job.

## Source availability and reproducibility limits

An unauthenticated HTTPS request to the
[exact stock Heddle commit API](https://api.github.com/repos/HeddleCo/heddle/commits/878fea434d2eed86865c0daf3f3b1ab7da6d2e4f)
returned HTTP 200 and that exact commit SHA on 2026-10-10. The source commit is
publicly readable through that API without a GitHub token. A local Git transport
probe with all environment configuration removed could not resolve `github.com`
in this executor. The completed Actions job subsequently passed its anonymous
pinned-upstream Git transport preflight; local connectivity is not claimed.

The Dockerfile's Heddle source revision and Cargo lockfile are pinned, and a
between-stage checksum verifies binary identity. Its `rust:1.98-trixie`,
`node:22-trixie-slim`, `debian:trixie-slim` and Dockerfile frontend tags, Debian
package versions and registry availability are not immutable inputs. Therefore
this is a reproducible **procedure with a pinned application source**, not a
claim of bit-for-bit image reproducibility. Record the actual image ID and
build output. Do not silently replace the upstream source or add credentials if
the public fetch fails; report the dependency/access failure for review.

## Cost check before running

The private repository's owner's current plan, unused included minutes,
spending budget and payment settings are **not verified**. The connected GitHub
repository tools do not expose billing endpoints; public documentation cannot
establish this account's remaining allowance. An organization owner or billing
manager can inspect its current billing usage/settings. GitHub also documents a
read-only organization usage endpoint, subject to organization Administration
(read) permission; do not create a credential or expand access just to query it.
See [GitHub billing usage API](https://docs.github.com/en/rest/billing/usage).

GitHub charges compute/storage according to account plan, allowances and current
rates; check [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
before the next run. The completed authorization covered one actual job with a
US$1 limit. The timing endpoint reported one Ubuntu job and zero billable
milliseconds, but no invoice or remaining allowance was independently verified.
Do not treat that API response as proof future usage is free. The proposed next
run retains bounded artifacts for one day and requires a fresh explicit
compute-plus-storage spending limit; reruns and further runs are additional.

## Local validation versus pending acceptance

The original pre-publication preparation checked YAML shape, exact action pin,
read-only permission scope, branch/event restrictions and no upload steps,
read-only test mount paths, shell syntax and unchanged runtime/context inputs.
Those checks passed without a Docker daemon. A synthetic shell harness also
executed all five shell blocks with mocked Docker/Git commands and proved that
oversize, root-user, failed selftest and unexpected manually selected source SHA
are rejected. Those mocks validate workflow glue only: they are not image or
native test evidence. Those earlier checks missed GitHub's expression-context
restrictions: `${{ runner.temp }}` is invalid in `jobs.<job_id>.env`, so the
published first attempt failed before executing any step.

The now-published context repair removed that job-level expression. The first shell step derives
and exports `DOCKER_CONFIG` from `$RUNNER_TEMP`, creates a private empty config,
and appends that exact path to `$GITHUB_ENV` for subsequent steps. Absolute-path
and CR/LF checks prevent a malformed path from adding another environment entry.
No untrusted value is interpolated into the shell program.

The context-repair regression checked its expression locations against
[GitHub's context-availability table](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability):
workflow concurrency uses `github`; job `if` uses `github`; job `env` uses
`github`/`inputs`; checkout `with.ref` uses `github`. These are permitted in their
respective locations. The new export uses `steps` at step conditions/environment,
`env`/`github` in artifact names and `runner` only in step inputs, all covered by
the separate export regression. Other values are literals or shell variables. The regression rejects the original `runner`-in-job-env form and
checks the environment-file handoff, including spaces and shell metacharacters
as literal path bytes and rejection of CR/LF injection. YAML, all five Bash
blocks and these focused positive/negative checks pass locally. `actionlint`
was not run locally. GitHub's service accepted the repaired workflow and
allocated the completed actual job; its build/image checks passed and the native
fixture failure above remains the full-suite blocker. The new export delta has
not yet been validated by a real GitHub run.

The prepared export workflow additionally passed local YAML/Bash/Node and
synthetic streaming checks: success-only test/upload gates, exact action pin,
fixed bounded file names and artifact count, deterministic gzip/manifest,
513 MiB uncompressed rejection, compressed-meter rejection, source/run/image
binding, ordered reconstruction and corruption/missing/extra/symlink/traversal
negatives. These do not execute Docker or upload an artifact and are not GitHub
service-level validation.

Still pending actual execution and verification (registry/deployment remain separately unapproved):

- Publication of the exact twelve-file delta as a direct child of the reviewed base
- One new actual job within an approved spend limit; no implicit retry authority
- Full native/recovery/race/ordered-publication and dependency-fixture passes
- New source/image identity and all tests tied to that new image
- Bounded private artifact export, actual part count and complete successful manifest
- Real artifact download/materialization and all source/part/archive checks
- Any separately approved software installation, registry import or hosted deployment

If a run fails, preserve the exact failed stage, inspect logs and seek fresh
approval for any new publication, spending or permission scope. Do not weaken
the trusted-tree, production context or credential boundaries to obtain a green
result. A complete hosted Worker/Container/R2 application remains unproven.
