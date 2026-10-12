// SPDX-License-Identifier: Apache-2.0
/** Keep the string[] API; use slash parity to distinguish escaped delimiters. */
export function parseRow(row: string): string[] {
  const text = row.trim();
  const cells: string[] = [];
  let cell = "";
  for (let i = text.startsWith("|") ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\" && (text[i + 1] === "\\" || text[i + 1] === "|")) {
      cell += text[++i];
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      if (i === text.length - 1) return cells;
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** Parse a table, ignoring its Markdown separator row. */
export function parseTable(markdown: string): string[][] {
  return markdown.trim().split(/\r?\n/)
    .filter(line => line.trim() && !/^\s*\|?\s*:?-{3,}/.test(line))
    .map(parseRow);
}
