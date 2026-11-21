/**
 * @fileoverview A horizon chart's table and summary: those of the over-time
 * chart or the heatmap whose fold it draws, at the size it draws, so every
 * row is accounted for as theirs are.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { HeatPlot, HorizonPlot, TimePlot } from "@document";
import type { HeatTally, TimeTally } from "@engine";
import { summaryOf } from "@renderer/chart/summary";
import { el } from "@renderer/shell/util";
import { ROOM, kindFor } from "../charted.ts";

const AT = { col: 0, header: "ordered" };
const REVENUE = { col: 5, header: "revenue" };

/** Revenue per region per month: North's March and April, South's April, from March 2024. */
const HEATED: HeatPlot = {
  t: "heat",
  by: { col: 1, header: "region" },
  at: AT,
  sum: REVENUE,
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
const HEAT: HeatTally = {
  t: "heat",
  plot: HEATED,
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

/** Revenue per day, over four days from Sunday 3 March 2024, the third empty. */
const TIMED: TimePlot = { t: "time", at: AT, sum: REVENUE, per: "day", order: "day" };
const TIME: TimeTally = {
  t: "time",
  plot: TIMED,
  coverage: { rows: 12, total: 12, complete: true },
  levels: [
    { per: "day", from: 19_785, span: 4, offset: 0, rows: [2, 4, 0, 1], sum: [150, 300, 0, 25.5] },
  ],
  undated: { rows: 5, sum: 40 },
  dates: { blank: 2, unparsed: 3, other: 0 },
  skipped: { blank: 1, unparsed: 0 },
};

/** The text of each row of `table`, cell by cell. */
const rowsOf = (table: HTMLElement): string[][] =>
  [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((cell) => cell.textContent ?? ""),
  );

/** What a window shows of `tally` drawn as `plot`: its table's rows, and its summary. */
const shown = (plot: HeatPlot | TimePlot | HorizonPlot, tally: HeatTally | TimeTally) => {
  const drawing = kindFor(plot).drawing(tally, ROOM)!;
  const said = summaryOf("revenue", "sales.csv", tally.coverage.rows, drawing.told()).said;
  return { table: rowsOf(drawing.table(el("bdi", "", "revenue"))), said };
};

test("a horizon by a column tables and sums up as the heatmap of its columns does", () => {
  const horizon = shown({ ...HEATED, t: "horizon" }, HEAT);
  expect(horizon).toStrictEqual(shown(HEATED, HEAT));
  expect(horizon.table[0]).toEqual(["region", "month", "rows", "revenue"]);
  expect(horizon.said).toContain("the most in North, April 2024: 150.");
});

test("a horizon of one series tables and sums up as the over-time chart of its columns does", () => {
  const horizon = shown({ ...TIMED, t: "horizon" }, TIME);
  expect(horizon).toStrictEqual(shown(TIMED, TIME));
  expect(horizon.table.at(-2)).toEqual(["no date", "5", "40"]);
});
