<!-- SPDX-License-Identifier: Apache-2.0 -->
# Tiny Markdown tables

A dependency-free TypeScript library exporting `parseRow(row): string[]` and
`parseTable(markdown): string[][]`. Cells are trimmed; outer pipes are optional.

```ts
parseRow("| name | score |"); // ["name", "score"]
```

Run `npm ci && npm test`. The prepared `parser-escapes` task adds escape support;
`docs-readme` explains the existing API independently.
