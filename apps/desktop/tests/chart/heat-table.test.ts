/**
 * @fileoverview A heatmap over periods' table and summary: a row per value
 * and period drawn, empty ones too, then each value's rows with no date and
 * the values not sent, and a sentence that names the cell of the most.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { HeatPlot } from "@document";
import type { HeatTally } from "@engine";
import { summaryOf } from "@renderer/chart/summary";
import { el } from "@renderer/shell/util";
import { ROOM, kindFor } from "../charted.ts";

/** Revenue per region per month: North's March and April, South's April, from March 2024. */
const PLOT: HeatPlot = {
  t: "heat",
  by: { col: 1, header: "region" },
  at: { col: 0, header: "ordered" },
  sum: { col: 5, header: "revenue" },
  per: "month",
  order: "day",
};
const value = (name: string, rows: number, sum: number, undated = 0) => ({
  value: name,
  rows,
  sum,
  undated: { rows: undated, sum: 0 },
  unsplit: { rows: 0, sum: 0 },
});
const TALLY: HeatTally = {
  t: "heat",
  plot: PLOT,
  coverage: { rows: 9, total: 9, complete: true },
  values: [value("North", 4, 300, 1), value("South", 2, -40)],
  levels: [
    {
      per: "month",
      from: 650,
      span: 2,
      rows: [
        [1, 2],
        [0, 2],
      ],
      sum: [
        [100, 150],
        [0, -40],
      ],
    },
  ],
  others: { values: 2, rows: 3, sum: 0 },
  dates: { blank: 1, unparsed: 0, other: 0 },
  skipped: { blank: 1, unparsed: 0 },
};

/** The text of each row of `table`, cell by cell. */
const rowsOf = (table: HTMLElement): string[][] =>
  [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((cell) => cell.textContent ?? ""),
  );

test("the table lists each value's periods drawn, empty ones too, then its undated rows, the values not sent and the cells not added", () => {
  const drawing = kindFor(PLOT).drawing(TALLY, ROOM)!;
  expect(rowsOf(drawing.table(el("bdi", "", "revenue per region per month")))).toStrictEqual([
    ["region", "month", "rows", "revenue"],
    ["North", "Mar 2024", "1", "100"],
    ["North", "Apr 2024", "2", "150"],
    ["South", "Mar 2024", "0", "0"],
    ["South", "Apr 2024", "2", "-40"],
    ["North", "no date", "1", "0"],
    ["+2 more · 3 rows"],
    ["1 blank"],
  ]);
});

test("the summary names the span and the cell that holds the most", () => {
  const told = kindFor(PLOT).drawing(TALLY, ROOM)!.told();
  expect(summaryOf("revenue per region per month", "sales.csv", 9, told).said).toBe(
    "revenue per region per month in sales.csv, 9 rows. From March 2024 to April 2024, the most in North, April 2024: 150.",
  );
});
