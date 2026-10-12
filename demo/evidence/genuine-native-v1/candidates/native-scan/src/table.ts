// SPDX-License-Identifier: Apache-2.0
/** Parse one Markdown table row, decoding escaped pipes and backslashes. */
export function parseRow(row: string): string[] {
  const text = row.trim();
  const cells: string[] = [];
  let cell = "";

  for (let i = text.startsWith("|") ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "\\" && (next === "\\" || next === "|")) {
      // Consume pairs left to right so only an odd final backslash escapes a pipe.
      cell += next;
      i++;
    } else if (char === "|") {
      // A literal trailing pipe is consumed above, never mistaken for a border.
      if (i < text.length - 1) {
        cells.push(cell.trim());
        cell = "";
      }
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
