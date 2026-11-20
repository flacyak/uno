/**
 * @fileoverview A box plot's rows: each value's box, highest median first,
 * then Other's, or a column's one box.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { BoxTally } from "@engine";
import { m } from "@paraglide/messages";
import { boxedRows } from "@renderer/chart/box";
import type { Box, Spread } from "@tally";

/** A box whose numbers all stand at `at`. */
const boxAt = (at: number): Box => ({
  mean: at,
  five: [0, 1, 2, 3, 4].map(() => [at, at]),
  whiskers: [
    [at, at],
    [at, at],
  ],
  below: { rows: 0, buckets: [] },
  above: { rows: 0, buckets: [] },
  span: [
    [at, at],
    [at, at],
  ],
});

/** A spread of one number `at`, or of none. */
const spreadOf = (at?: number): Omit<Spread, "levels"> => ({
  numbers: at === undefined ? 0 : 1,
  figures: "exact",
  ...(at === undefined ? {} : { box: boxAt(at) }),
  skipped: { blank: at === undefined ? 1 : 0, unparsed: 0 },
});

const TALLY: BoxTally = {
  t: "box",
  plot: {
    t: "box",
    of: { col: 2, header: "amount" },
    by: { col: 1, header: "region" },
    span: "most",
  },
  coverage: { rows: 4, total: 4, complete: true },
  values: [
    { value: "West", spread: spreadOf(9) },
    { value: "", spread: spreadOf(5) },
    { value: "East", spread: spreadOf() },
  ],
  rest: spreadOf(1),
  skipped: { blank: 1, unparsed: 0 },
};

test("a box plot's rows are each value's box in the order sent, a value of no number left out, then Other's", () => {
  expect(boxedRows(TALLY, "amount").map(({ label, box }) => [label, box.mean])).toStrictEqual([
    ["West", 9],
    ["", 5],
    [m.chart_pie_other(), 1],
  ]);
});

test("a box plot of no values is its column's one box, or no row where it has no number", () => {
  const whole = { ...TALLY, values: [], rest: spreadOf(3) };
  expect(boxedRows(whole, "amount").map(({ label }) => label)).toStrictEqual(["amount"]);
  expect(boxedRows({ ...whole, rest: spreadOf() }, "amount")).toStrictEqual([]);
  expect(boxedRows({ ...TALLY, rest: undefined }, "amount")).toHaveLength(2);
});
