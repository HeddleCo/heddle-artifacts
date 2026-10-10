<!-- SPDX-License-Identifier: Apache-2.0 -->
# A-S1: real Artifacts smoke pending

The sandbox has no Cloudflare credentials. No live Artifacts, Queue, Container,
or deployment result is claimed.

Exact attempted command:

```sh
TMPDIR=/home/scratch bash scripts/smoke-artifacts.sh
```

Output (exit 2):

```text
A-S1 BLOCKED: CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required outside the sandbox.
```

The owner can run this command with those variables outside the sandbox. The
namespace defaults to `heddle-demo`. The script creates temporary repos and a
Queue with an HTTP pull consumer, subscribes to canonical `pushed` events,
checks create/fork/token minting, main/candidate/notes refs, atomic push,
non-fast-forward notes behavior without force-pushing, and actual delivery
latency. It deletes only resources it created and replaces this file with the
live transcript. Its credentials never enter command output or Git URLs.

Named fallbacks remain §9 R1 (why branch or parented notes commits) and R3
(always-on alarm polling while lanes are active). A local bare-Git rejection of
non-fast-forward notes is not evidence about Artifacts. Live notes rejection
must activate R1 in the engine before integration; atomic rejection requires
separate ref pushes.

The script itself is verified locally with `--fake`; the deliberately missing
ref mode `--fake --prove-ref-check` exits 1. This proves its ref check is
load-bearing, not that the Cloudflare service supports these refs.

Sources used for the control-plane shape:
[Artifacts binding](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/),
[event schemas](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/),
[Queue pull](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/pull/).
