<!-- SPDX-License-Identifier: Apache-2.0 -->
# Current production-container build proposal

Status, 2026-10-10: **local preparation only; no CI run or image build yet.**
The hardened runtime differs from the historical PR #4 image. Its earlier
338,926,309-byte result does not establish the current image's size or behavior.
This executor has no Docker, Podman or BuildKit, so YAML/shell/static checks here
are not a substitute for the proposed container run.

## Proposed approval boundary

After reviewing the final source snapshot, ask the owner to approve these
specific external actions together:

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

This proposal does not authorize a merge, a deployment, image/registry
publication, Actions artifact uploads, new secrets, billing changes, persistent
runners or permissions changes. No such action has been performed. Future pushes
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
- No upload or persistent cache action is present. The image and temporary
  state exist only on the disposable runner. Job logs/summary still leave that
  runner and are visible according to the repository's Actions access policy.

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
in this executor, so anonymous Git transport is a pending runner preflight,
not a claimed local pass.

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

GitHub charges private-repository runner usage to the repository owner, with
included allowances varying by plan. The currently documented baseline Linux
2-core rate is **US$0.006/minute**. If all 60 minutes were billable at that rate,
the compute component would be **US$0.36 for one run**, before taxes or
account-specific terms. That is an estimate, not a verified account bill or a
hard billing cap. Reruns are additional. No artifacts or remote caches are
uploaded by this workflow. Verify current pricing and approve an explicit limit
before starting: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Local validation versus pending acceptance

Local preparation checks YAML shape, exact action pin, read-only permission
scope, branch/event restrictions, absence of secrets/publish/upload steps,
read-only test mount paths, shell syntax and unchanged runtime/context inputs.
Those checks passed without a Docker daemon. A synthetic shell harness also
executed all five shell blocks with mocked Docker/Git commands and proved that
oversize, root-user, failed selftest and unexpected manually selected source SHA
are rejected. Those mocks validate workflow glue only: they are not image or
native test evidence. GitHub's workflow service and `actionlint` have not
validated this YAML.

Still pending until separately approved and actually observed:

- Final source publication and draft PR URL/head SHA
- Repository-owner billing/allowance check and approval of the first run
- Anonymous Git fetch and current image build on the runner
- Current image ID, measured bytes, selftest and in-image native/dependency tests
- Actions run URL and terminal result for the exact approved commit

If the run fails, keep the failed stage explicit. Inspect logs before proposing
a change or retry, preserve the trusted-tree/context boundaries, and seek new
approval if publication, spend or permissions would exceed the approved scope.
