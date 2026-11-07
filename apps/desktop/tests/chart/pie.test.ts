/**
 * @fileoverview A pie chart's slices of a tally: one for each value above zero,
 * the six largest first, and Other after them for the rest. Each runs its share
 * of the way round from the top, wears a chart colour, Other the caption's ink,
 * and a line of the page's ground parts it from the next slice round the ring.
 * A label past the ring by the middle of each arc gives its value and its share.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { Group, Groups } from "@engine";
import { m } from "@paraglide/messages";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { PIE_SLICES_AT_MOST, pie, slices } from "@renderer/chart/pie";
import type { Slice } from "@renderer/chart/pie";
import { percent } from "@renderer/locale";

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

/** Rows per region: half of them North, and a quarter each South and West. */
const HALVED = tallyOf(sent("North", 2), sent("South", 1), sent("West", 1));

/** The paths `box`'s `selector` draw. */
const paths = (box: HTMLElement, selector = ".chart-slice"): Array<string | null> =>
  [...box.querySelectorAll(selector)].map((at) => at.getAttribute("d"));

/** `box`'s labels, in the order of their slices. */
const labels = (box: HTMLElement): HTMLElement[] =>
  Array.from(box.querySelectorAll<HTMLElement>(".chart-slice-label"));

afterEach(() => {
  void setLocale(baseLocale, { reload: false });
});

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
  expect(paths(pie(ROWS, HALVED))).toStrictEqual([
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

test("each slice wears the chart colours in order, and Other the caption's ink", () => {
  const drawn = [...pie(ROWS, EIGHT).querySelectorAll<SVGElement>(".chart-slice")];
  const own = Array.from({ length: PIE_SLICES_AT_MOST }, (_, i) => `var(--chart-${i + 1})`);
  const keys = drawn.map((slice) => slice.style.getPropertyValue("--key"));
  expect(keys).toStrictEqual([...own, "var(--ink-3)"]);
});

test("a line parts each slice from the next, over them all, and a lone one from none", () => {
  const box = pie(ROWS, HALVED);
  expect(paths(box, ".chart-slice-gap")).toStrictEqual(["M0 0L0 -1", "M0 0L0 1", "M0 0L-1 0"]);
  expect(box.querySelector(".chart-slice-gap ~ .chart-slice")).toBeNull();
  expect(pie(ROWS, tallyOf(sent("North", 3))).querySelector(".chart-slice-gap")).toBeNull();
});

test("a slice's label is its value as the file has it and its share, and Other's its own name", () => {
  const box = pie(ROWS, tallyOf(sent("<b>North</b>", 2), ...HALVED.groups.slice(1)));
  const said = labels(box).map((label) => label.textContent);
  expect(said).toStrictEqual(["<b>North</b> 50%", "South 25%", "West 25%"]);
  expect(box.querySelector(".chart-slice-label .from-file")?.textContent).toBe("<b>North</b>");
  void setLocale("es", { reload: false });
  const rows = EIGHT.groups.map((g) => g.rows);
  const sum = (ns: number[]): number => ns.reduce((total, n) => total + n, 0);
  const share = sum(rows.slice(PIE_SLICES_AT_MOST)) / sum(rows);
  const other = labels(pie(ROWS, EIGHT)).at(-1)!;
  expect(other.textContent).toBe(`${m.chart_pie_other()} ${percent(share)}`);
  expect(other.querySelector(".from-file")).toBeNull();
});

test("a label holds where its slice's middle stands on the ring, a lone slice's straight below", () => {
  // North's middle is a quarter of the way round, and South's and West's five
  // and seven eighths, as far from the middle across as down or up. A lone
  // slice's is half way, straight below, where x rounds to none.
  const drawn = [...labels(pie(ROWS, HALVED)), ...labels(pie(ROWS, tallyOf(sent("North", 3))))];
  const [x, y] = ["--x", "--y"].map((at) => drawn.map((label) => label.style.getPropertyValue(at)));
  expect(x).toStrictEqual(["1", "-0.707107", "-0.707107", "0"]);
  expect(y).toStrictEqual(["0", "0.707107", "-0.707107", "1"]);
});
