/**
 * @fileoverview A pie chart's slices of a tally: one for each value above zero,
 * the six largest first, and Other after them for the rest.
 * Each runs its share of the way round from the top.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Group, Groups } from "@engine";
import { PIE_SLICES_AT_MOST, pie, slices } from "@renderer/chart/pie";
import type { Slice } from "@renderer/chart/pie";

const ROWS = { t: "pie", by: { col: 1, header: "region" } } as const;
const SUMS = { ...ROWS, sum: { col: 5, header: "revenue" } };

/** A tally of `groups` alone. */
function tallyOf(...groups: Group[]): Groups {
  const none = { values: 0, rows: 0, sum: 0 };
  return { groups, others: none, below: none, rest: none, skipped: { blank: 0, unparsed: 0 } };
}

/** A value sent of `rows` rows, whose cells sum to `sum`. */
const sent = (value: string, rows: number, sum = rows): Group => ({ value, rows, sum });

/** Eight values sent, the largest first: six for slices, and two more for Other. */
const EIGHT = tallyOf(...[80, 70, 60, 50, 40, 30, 20, 10].map((n, i) => sent(`v${i + 1}`, n)));

/** The first `count` of `groups`'s values, each with its rows, as slices. */
const firstOf = (groups: Groups, count = groups.groups.length): Slice[] =>
  groups.groups.slice(0, count).map(({ value, rows }) => ({ value, size: rows }));

/** The paths `box`'s slices draw. */
const paths = (box: HTMLElement): Array<string | null> =>
  [...box.querySelectorAll(".chart-slice")].map((slice) => slice.getAttribute("d"));

test("each value above zero has a slice, the largest first, of its rows or its sum", () => {
  const regions = tallyOf(sent("North", 1204, 48160.5), sent("South", 812, 0), sent("West", 3, -1));
  expect(slices(ROWS, regions)).toStrictEqual(firstOf(regions));
  expect(slices(SUMS, regions)).toStrictEqual([{ value: "North", size: 48160.5 }]);
});

test("the six largest values have a slice each, and Other after them adds the rest", () => {
  const unsent = { values: 40, rows: 25, sum: 0 };
  const beyond = { rows: 5, sum: 0 };
  const after = EIGHT.groups.slice(PIE_SLICES_AT_MOST).reduce((sum, g) => sum + g.rows, 0);
  expect(slices(ROWS, { ...EIGHT, others: unsent, rest: beyond })).toStrictEqual([
    ...firstOf(EIGHT, PIE_SLICES_AT_MOST),
    { value: undefined, size: after + unsent.rows + beyond.rows },
  ]);
});

test("Other leaves out the values at or below zero, and takes those past a tally's own where they net above it", () => {
  const sums = tallyOf(...EIGHT.groups.slice(0, PIE_SLICES_AT_MOST), sent("v7", 20, -20));
  const other = (sum: number): number | undefined =>
    slices(SUMS, { ...sums, rest: { rows: 2, sum } })[PIE_SLICES_AT_MOST]?.size;
  expect(other(15)).toBe(15);
  expect(other(-15)).toBeUndefined();
});

test("a pie of fewer than six slices has no Other, nor one of six with nothing past them", () => {
  const five = tallyOf(...EIGHT.groups.slice(0, PIE_SLICES_AT_MOST - 1));
  expect(slices(ROWS, { ...five, rest: { rows: 20, sum: 0 } })).toStrictEqual(firstOf(five));
  const six = tallyOf(...EIGHT.groups.slice(0, PIE_SLICES_AT_MOST));
  expect(slices(ROWS, six)).toStrictEqual(firstOf(six));
});

test("each slice runs its share of the way round, clockwise from the top, the largest first", () => {
  const halved = tallyOf(sent("North", 2), sent("South", 1), sent("West", 1));
  expect(paths(pie(ROWS, halved))).toStrictEqual([
    "M0 0L0 -1A1 1 0 0 1 0 1Z",
    "M0 0L0 1A1 1 0 0 1 -1 0Z",
    "M0 0L-1 0A1 1 0 0 1 0 -1Z",
  ]);
});

test("a slice of more than half goes the long way round, and a lone one is the whole ring", () => {
  const most = tallyOf(sent("North", 3), sent("South", 1));
  expect(paths(pie(ROWS, most))[0]).toBe("M0 0L0 -1A1 1 0 1 1 -1 0Z");
  const lone = pie(ROWS, tallyOf(sent("North", 3)));
  expect(lone.querySelector("circle.chart-slice")?.getAttribute("r")).toBe("1");
});

test("a pie of nothing above zero, or of a whole no double holds, draws nothing", () => {
  expect(pie(SUMS, tallyOf(sent("North", 3, 0))).childElementCount).toBe(0);
  const most = sent("North", 1, Number.MAX_VALUE);
  expect(pie(SUMS, tallyOf(most, { ...most, value: "South" })).childElementCount).toBe(0);
});
