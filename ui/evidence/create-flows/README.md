<!-- SPDX-License-Identifier: Apache-2.0 -->
# Create-and-drive screens (issue #68)

Seven screens at 1280×720 and 1440×900, light and dark (28 images), from `test/create-flows.spec.ts` against the mock API:

| File prefix | What it shows |
|---|---|
| `visitor-root` | A visitor at `/` sees the public demo board, with no create forms and the address left as `/`. |
| `operator-new-project` | An operator at `/`: the new-project form (repository address, test command, the id suggested from the address). |
| `operator-new-task` | The new-task form on a board, the task name suggested from the intent. |
| `operator-empty-board` | An empty board tells an operator what to do next. |
| `operator-add-agent` | The `OPERATOR_TOKEN=… node cli/ha.mjs join …` command for putting your own agent on a task. |
| `visitor-no-decider` | With nobody to decide as, a visitor is told to sign in as an operator. |
| `operator-add-name` | The same place for an operator: a name field and "Add me". |

Regenerate: `CREATE_EVIDENCE_DIR=evidence/create-flows CI=1 npm test -- test/create-flows.spec.ts`. The spec checks for horizontal overflow on every run
(it caught the join command overflowing at 1280 px, now wrapped). Not covered: mobile widths.
