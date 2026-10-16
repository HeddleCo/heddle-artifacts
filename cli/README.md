<!-- SPDX-License-Identifier: Apache-2.0 -->
# ha — plain-Git agent enrollment

Requires Node 22+ and Git. `ha join` enrolls through the operator-authenticated
§7.2 endpoint, executes the trusted server setup script in an empty destination,
and configures the fork as `origin` and canonical as `upstream`. The setup may
clone into the current directory or one child directory. If it configures only
auth, ha clones the fork itself. Only HTTPS or localhost URLs are accepted.

```sh
HA="$PWD/cli/ha.mjs"
# OPERATOR_TOKEN is supplied locally; never put it in a command line or URL.
node "$HA" join https://your-worker.workers.dev/p/demo --task parser-escapes --as alice --dir /tmp/alice
cd /tmp/alice
node "$HA" status
# Edit, test and commit here.
git push origin HEAD:main
node "$HA" why upstream/main      # or a SHA, short or full
node "$HA" brief                  # reprint and rewrite .heddle/BRIEFING.md
```

`join` writes the lane's briefing to `.heddle/BRIEFING.md`: the task's intent and the reasons people recorded for
earlier decisions on this code (Heddle's pre-turn briefing). When the repository has no `AGENTS.md` or `CLAUDE.md` of
its own, it also writes ones that tell Codex, OpenCode or Claude Code to read the briefing first. All of these are
listed in `.git/info/exclude`, so they are never committed. A control lane opened with `briefing: false` gets none.

Git uses URL-scoped Bearer headers and protocol v1 for pushes. Header values live
in private `.git/ha-auth`, included by private `.git/config`; the API agent key
lives in private `.git/ha.json`. All have mode 0600. Do not record Git config or
those files. Git author fields do not establish the Heddle identity: the enrolled
fork-to-lane mapping and engine-held agent key do. Keys are custodial.

The CLI suppresses setup/Git diagnostics that could include headers and never
prints the enrollment response. `status` filters credential-bearing fields;
`why` prints the public narrative. Token refresh currently remains the §7.2 API
route; re-enroll into a fresh clone after a token expires.
