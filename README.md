# heddle-artifacts

Heddle on Cloudflare Artifacts. A Git platform where many agents work on one codebase at the same time:

- Each agent pushes plain `git` to its own Artifacts fork.
- Overlapping work becomes **comparable candidates**, not rejected pushes.
- Every landing on `main` carries its **why** (intent, alternatives, review, decision) in `refs/notes/heddle`.

Status: under construction for Cloudflare's "Build the next Git platform" competition. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Licensed under Apache-2.0.
