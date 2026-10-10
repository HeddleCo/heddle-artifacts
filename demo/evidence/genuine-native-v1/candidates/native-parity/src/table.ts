// SPDX-License-Identifier: Apache-2.0
/** Parse one Markdown table row, including escaped pipes and backslashes. */
export function parseRow(row: string): string[] {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "\\") {
      const start = index;
      while (text[index] === "\\") index++;
      const runLength = index - start;
      cell += "\\".repeat(Math.floor(runLength / 2));

      // Pairs decode to backslashes; an odd remainder can escape a pipe.
      if (runLength % 2 === 1) {
        if (text[index] === "|") {
          cell += "|";
          index++;
        } else {
          cell += "\\";
        }
      }
      continue;
    }

    if (text[index] === "|") {
      cells.push(cell.trim());
      cell = "";
      // Only an unescaped final pipe is an optional outer boundary.
      if (index === text.length - 1) return cells;
    } else {
      cell += text[index];
    }
    index++;
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
