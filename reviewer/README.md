<!-- SPDX-License-Identifier: Apache-2.0 -->
# Worker reviewer

Track A binds `env.AI` once and calls the §7.4 function after its five-second debounce:

```ts
import { createReviewer } from '../reviewer/reviewer';
const review = createReviewer(env);
const result = await review({ intent, base, candidates, turns });
// Enroll reviewer with its own key, then engine discuss with result.summary/perCandidate.
// The model never signs, mutates the repository, or makes the human decision.
```

`review(input, env)` is also exported for direct callers. Calling `review(input)`
without AI gives the labeled fallback. Missing AI, transport errors, or three
invalid responses return schema-valid `model:"fallback"` with concerns and no
recommendation. Each AI attempt has a 30-second deadline. JSON/schema failures get at most two retries. Candidate ids must
be distinct; verdicts must cover the exact input set; picks must name a supplied
candidate with passing tests. No raw model output, error messages or tokens are logged.

Pin: `@cf/qwen/qwen2.5-coder-32b-instruct`, verified 2026-10-10 against
[Cloudflare's code-model page](https://developers.cloudflare.com/workers-ai/models/qwen2.5-coder-32b-instruct/).
The request uses `response_format: {type:"json_schema", json_schema:...}` from
[Cloudflare JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/).
Cloudflare documents that schema adherence is not guaranteed, so we also validate
at runtime. Recheck model availability on Sunday before the remote-binding take.

```sh
npm ci --prefix reviewer
npm test --prefix reviewer
npm run check --prefix reviewer
```

Dependencies here are test-only: the Worker implementation has no npm runtime imports.
`types.local.ts` is the exact §7.1 copy; TODO: switch to contracts/ after Track A lands.
