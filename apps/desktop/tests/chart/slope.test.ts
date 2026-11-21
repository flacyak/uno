/**
 * @fileoverview A slope chart's rows: each value's two ends as the chart
 * measures them, the first SLOPES_AT_MOST of them, and the rest counted.
 */

import { expect, test } from "vite-plus/test";

import type { SlopePlot } from "@document";
import type { SlopeTally } from "@engine";
import { SLOPES_AT_MOST, sloped } from "@renderer/chart/slope";
import type { Ended } from "@tally";

const REGION = { col: 0, header: "region" };
const YEAR = { col: 1, header: "year" };
const REVENUE = { col: 2, header: "revenue" };
const ROWS: SlopePlot = { t: "slope", by: REGION, between: YEAR, from: "2024", to: "2025" };
const SUMS: SlopePlot = { ...ROWS, of: REVENUE, measure: "sum" };

/** An end of `sum` over `rows` rows, `numbers` of them numbers. */
const end = (sum: number, rows: number, numbers = rows): Ended => ({ rows, sum, numbers });
const NONE = end(0, 0);

/** A tally of values, each with its two ends. */
function tallyOf(values: Array<[string, Ended, Ended]>, plot = SUMS): SlopeTally {
  return {
    t: "slope",
    plot,
    coverage: { rows: 10, total: 10, complete: true },
    values: values.map(([value, from, to]) => ({ value, ends: [from, to], unsplit: false })),
    others: { values: 0, rows: 0 },
    rest: { rows: 0, sum: 0 },
    skipped: { blank: 0, unparsed: 0 },
  };
}

test("a slope's rows stand at each end's rows, sum or mean, none at an end of no rows or no number", () => {
  const tally = tallyOf([
    ["East", end(10, 2), end(30, 3, 2)],
    ["West", end(40, 1, 0), NONE],
  ]);
  const ends = (plot: SlopePlot) => sloped(plot, { ...tally, plot }).rows.map((r) => r.ends);
  expect(ends(ROWS)).toStrictEqual([
    [2, 3],
    [1, undefined],
  ]);
  expect(ends(SUMS)).toStrictEqual([
    [10, 30],
    [40, undefined],
  ]);
  expect(ends({ ...SUMS, measure: "mean" })).toStrictEqual([
    [5, 15],
    [undefined, undefined],
  ]);
  expect(sloped(SUMS, tally).states).toStrictEqual(["2024", "2025"]);
});

test("a slope's rows are its first SLOPES_AT_MOST values, the rest counted with those the tally sent none of, and a value of rows apart from its states stands nowhere", () => {
  const values = Array.from({ length: SLOPES_AT_MOST + 2 }, (_, i): [string, Ended, Ended] => [
    `v${i}`,
    end(i, 1),
    end(i, 1),
  ]);
  const tally = { ...tallyOf(values), others: { values: 3, rows: 7 } };
  tally.values[0] = { ...tally.values[0]!, unsplit: true };
  const { rows, more } = sloped(SUMS, tally);
  expect(rows).toHaveLength(SLOPES_AT_MOST);
  expect(rows[0]!.ends).toStrictEqual([undefined, undefined]);
  expect(more).toBe(5);
});
