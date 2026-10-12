<!-- SPDX-License-Identifier: Apache-2.0 -->
# Tiny Markdown tables

A dependency-free TypeScript library. Import `parseRow` and `parseTable` from
`src/table.ts`. Both return arrays of trimmed strings.

```ts
import { parseRow, parseTable } from "./src/table";
parseRow("| name | score |"); // ["name", "score"]
parseRow("| Alice || 7 |");  // ["Alice", "", "7"]
parseTable("| name | score |\n| --- | --- |\n| Alice | 7 |");
// [["name", "score"], ["Alice", "7"]]
```

Outer pipes are optional. Empty cells stay empty; Unicode and CRLF are supported.
Separator rows are skipped by `parseTable`. This tiny parser is not a full CommonMark
renderer: inline formatting and cell-width validation are left to the caller.

```sh
npm ci
npm test
npm run check
```

The independent `parser-escapes` task adds escaped-pipe support without changing
these return types. This documentation candidate changes no parser code.
