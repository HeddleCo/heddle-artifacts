// SPDX-License-Identifier: Apache-2.0
/** Parse one Markdown table row. Cells keep their whitespace: code tables need their indentation. */
export function parseRow(row: string): string[] {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|");
}

/** Parse a table, ignoring its Markdown separator row. */
export function parseTable(markdown: string): string[][] {
  return markdown.trim().split(/\r?\n/)
    .filter(line => line.trim() && !/^\s*\|?\s*:?-{3,}/.test(line))
    .map(parseRow);
}
