/**
 * @fileoverview A slope chart's title, which names its states; its table, which
 * lists each value's ends and change, then the values and cells left out; and
 * its summary, which names its values with their ends.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { SlopePlot } from "@document";
import type { SlopeTally } from "@engine";
import { el } from "@renderer/shell/util";
import { ROOM, kindFor } from "../charted.ts";

const REGION = { col: 0, header: "region" };
const YEAR = { col: 1, header: "year" };
const REVENUE = { col: 2, header: "revenue" };
const SUMS: SlopePlot = {
  t: "slope",
  by: REGION,
  between: YEAR,
  from: "2024",
  to: "2025",
  of: REVENUE,
  measure: "sum",
};

const TALLY: SlopeTally = {
  t: "slope",
  plot: SUMS,
  coverage: { rows: 12, total: 12, complete: true },
  values: [
    {
      value: "South",
      ends: [
        { rows: 1, sum: 200, numbers: 1 },
        { rows: 1, sum: 150, numbers: 1 },
      ],
      unsplit: false,
    },
    {
      value: "West",
      ends: [
        { rows: 1, sum: 150, numbers: 1 },
        { rows: 0, sum: 0, numbers: 0 },
      ],
      unsplit: false,
    },
    {
      value: "",
      ends: [
        { rows: 2, sum: 100, numbers: 2 },
        { rows: 1, sum: 140, numbers: 1 },
      ],
      unsplit: false,
    },
  ],
  others: { values: 2, rows: 3 },
  rest: { rows: 0, sum: 0 },
  skipped: { blank: 1, unparsed: 0 },
};

test("a slope chart's title says what it measures per value and its two states", () => {
  expect(kindFor(SUMS).title()).toBe("sum of revenue per region, 2024 to 2025");
  const rows: SlopePlot = { t: "slope", by: REGION, between: YEAR, from: "a", to: "b" };
  expect(kindFor(rows).title()).toBe("rows per region, a to b");
});

test("a slope chart's table lists each value's two ends, its change and its change as a share, then the values and cells left out", () => {
  const table = kindFor(SUMS).drawing(TALLY, ROOM)!.table(el("span"));
  const lines = [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((cell) => cell.textContent).join(" | "),
  );
  expect(lines).toStrictEqual([
    "region | 2024 | 2025 | change | share",
    "South | 200 | 150 | -50 | -25%",
    "West | 150 | none |  | ",
    "(blank) | 100 | 140 | 40 | 40%",
    "+2 more | 3 rows",
    "1 blank",
  ]);
});

test("a slope chart's summary names its values in order, each with its two ends, and counts the rest", () => {
  expect(kindFor(SUMS).drawing(TALLY, ROOM)!.told()).toStrictEqual({
    span: "",
    each: ["South 200 to 150", "West 150 to none", "(blank) 100 to 140"],
    more: 2,
  });
});
