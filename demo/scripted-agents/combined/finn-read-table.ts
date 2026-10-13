
/** Split a Markdown table into its header row and its body rows. */
export function readTable(markdown: string): { header: string[]; rows: string[][] } {
  const [header = [], ...rows] = parseTable(markdown);
  return { header, rows };
}
