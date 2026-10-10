// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { parseRow } from "../src/table";
it("keeps escaped pipes inside cells", () => expect(parseRow(String.raw`| a\|b | c |`)).toEqual(["a|b", "c"]));
it("does not trim an escaped trailing pipe", () => expect(parseRow(String.raw`a\|`)).toEqual(["a|"]));
it("even slash parity leaves a delimiter", () => expect(parseRow(String.raw`| a\\| b |`)).toEqual(["a\\", "b"]));
it("odd slash parity escapes a pipe", () => expect(parseRow(String.raw`| a\\\|b | c |`)).toEqual([String.raw`a\|b`, "c"]));
