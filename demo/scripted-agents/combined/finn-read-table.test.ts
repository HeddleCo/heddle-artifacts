// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { readTable } from "../src/table";

const table = "| Name | Age |\n| ---- | --- |\n| Ann  | 31  |\n| Bo   | 7   |";
describe("readTable", () => {
  it("returns the header", () => expect(readTable(table).header).toEqual(["Name", "Age"]));
  it("returns the body rows", () => expect(readTable(table).rows).toEqual([["Ann", "31"], ["Bo", "7"]]));
  it("handles a header-only table", () => expect(readTable("| A | B |")).toEqual({ header: ["A", "B"], rows: [] }));
  it("handles an empty table", () => expect(readTable("")).toEqual({ header: [], rows: [] }));
});
