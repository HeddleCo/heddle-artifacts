// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseRow, parseTable } from "../src/table";

describe("parseRow", () => {
  it.each([
    ["| a | b |", ["a", "b"]],
    ["a | b", ["a", "b"]],
    ["| a | b", ["a", "b"]],
    ["a | b |", ["a", "b"]],
    ["| a |", ["a"]],
    ["| a || b |", ["a", "", "b"]],
    ["  | a | b |  ", ["a", "b"]],
    ["| 1 | 2 |", ["1", "2"]],
    ["| α | β |", ["α", "β"]],
    ["", [""]],
    ["| |", [""]],
    ["solo", ["solo"]],
  ])("parses %s", (row, cells) => expect(parseRow(row)).toEqual(cells));
});
it("ignores the separator", () => expect(parseTable("| A | B |\n| --- | --- |\n| 1 | 2 |"))
  .toEqual([["A", "B"], ["1", "2"]]));
it("accepts CRLF", () => expect(parseTable("a | b\r\n1 | 2")).toHaveLength(2));
