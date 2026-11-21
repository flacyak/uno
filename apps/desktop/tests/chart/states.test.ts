/**
 * @fileoverview A column's states, as a slope's form offers them: the values
 * its sample holds, the most common first, the two it chooses, and how each
 * reads as an option.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import { STATES_AT_MOST, commonest, stateOption, twoOf } from "@renderer/chart/states";

/** A band of one column holding `cells`. */
const band = (cells: readonly string[]) => ({
  ready: (row: number) => row < cells.length,
  raw: (row: number) => cells[row] ?? "",
});

test("a column's states are its sample's values, the most common first, ties in sort order, read up to a row", () => {
  const cells = ["web", "direct", "web", "partner", "direct", "web", "mail", "fair"];
  expect(commonest(band(cells), 0, cells.length - 1)).toStrictEqual([
    "web",
    "direct",
    "mail",
    "partner",
  ]);
  const many = Array.from({ length: STATES_AT_MOST + 1 }, (_, i) => `${i}`.padStart(3, "0"));
  expect(commonest(band(many), 0, many.length)).toHaveLength(STATES_AT_MOST);
});

test("a slope's From and To are the two most common states, the earlier in sort order From, or one state twice", () => {
  expect(twoOf(["web", "direct", "partner"])).toStrictEqual(["direct", "web"]);
  expect(twoOf(["2025", "2024"])).toStrictEqual(["2024", "2025"]);
  expect(twoOf(["only"])).toStrictEqual(["only", "only"]);
  expect(twoOf([])).toStrictEqual(["", ""]);
});

test("a state reads as the file's value, and a blank one as the app's word for it", () => {
  const [web, blank] = ["web", ""].map(stateOption);
  expect([web!.textContent, web!.value, web!.className]).toStrictEqual(["web", "web", "from-file"]);
  expect([blank!.textContent, blank!.value, blank!.className]).toStrictEqual(["(blank)", "", ""]);
});
