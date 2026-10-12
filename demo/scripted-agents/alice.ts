// SPDX-License-Identifier: Apache-2.0
/** Handle escaped pipes with a compact split expression. */
export function parseRow(row: string): string[] {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
}

/** Parse a table, ignoring its Markdown separator row. */
export function parseTable(markdown: string): string[][] {
  return markdown.trim().split(/\r?\n/)
    .filter(line => line.trim() && !/^\s*\|?\s*:?-{3,}/.test(line))
    .map(parseRow);
}
