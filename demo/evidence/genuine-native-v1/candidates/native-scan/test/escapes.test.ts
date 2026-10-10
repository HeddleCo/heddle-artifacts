// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseRow, parseTable } from "../src/table";

describe("parseRow escape handling", () => {
  it.each([
    { name: "an escaped interior pipe", row: String.raw`a\|b | c`, cells: ["a|b", "c"] },
    { name: "an escaped leading pipe", row: String.raw`\|a | b`, cells: ["|a", "b"] },
    { name: "an escaped trailing pipe", row: String.raw`a | b\|`, cells: ["a", "b|"] },
    { name: "an escaped trailing pipe with whitespace", row: String.raw`  | a | b\|  `, cells: ["a", "b|"] },
    { name: "a literal pipe before a border", row: String.raw`| a | b\||`, cells: ["a", "b|"] },
    { name: "an empty cell after a literal pipe", row: String.raw`| a\| || b |`, cells: ["a|", "", "b"] },
    { name: "adjacent escaped pipes", row: String.raw`\|\|`, cells: ["||"] },
    { name: "unrelated escapes", row: String.raw`| \q | \n | \* |`, cells: [String.raw`\q`, String.raw`\n`, String.raw`\*`] },
    { name: "a backslash pair before text", row: String.raw`| a\\q | b |`, cells: [String.raw`a\q`, "b"] },
    { name: "Unicode next to escapes", row: String.raw`| α\|β | 😊\\🚀 |`, cells: ["α|β", String.raw`😊\🚀`] },
    { name: "empty input", row: "", cells: [""] },
    { name: "whitespace-only input", row: " \t ", cells: [""] },
    { name: "a single border", row: "|", cells: [""] },
    { name: "two borders", row: "||", cells: [""] },
    { name: "three pipes", row: "|||", cells: ["", ""] },
    { name: "consecutive empty cells", row: "||a|||b||", cells: ["", "a", "", "", "b", ""] },
  ])("preserves $name", ({ row, cells }) => {
    expect(parseRow(row)).toEqual(cells);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])("handles %i backslashes before an interior pipe", count => {
    const row = "left" + "\\".repeat(count) + "|right";
    const left = "left" + "\\".repeat(Math.floor(count / 2));
    const expected = count % 2 === 0 ? [left, "right"] : [left + "|right"];
    expect(parseRow(row)).toEqual(expected);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])("handles %i backslashes before the final pipe", count => {
    const row = "| left" + "\\".repeat(count) + "|";
    const content = "left" + "\\".repeat(Math.floor(count / 2)) + (count % 2 === 0 ? "" : "|");
    expect(parseRow(row)).toEqual([content]);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])("retains an unpaired backslash in a trailing run of %i", count => {
    expect(parseRow("left" + "\\".repeat(count))).toEqual([
      "left" + "\\".repeat(Math.ceil(count / 2)),
    ]);
  });
});

describe("parseTable with escaped cells", () => {
  it("decodes rows while retaining separator filtering and empty cells", () => {
    const markdown = [
      String.raw`| A\|B | C |`,
      "| :--- | ---: |",
      String.raw`| x\\y ||`,
      "",
      String.raw`| z | end\|`,
    ].join("\n");
    expect(parseTable(markdown)).toEqual([["A|B", "C"], [String.raw`x\y`, ""], ["z", "end|"]]);
  });

  it("retains CRLF support with optional borders and unrelated escapes", () => {
    const markdown = String.raw`a\|b | \q` + "\r\n" + String.raw`| c | d\| |`;
    expect(parseTable(markdown)).toEqual([["a|b", String.raw`\q`], ["c", "d|"]]);
  });
});
