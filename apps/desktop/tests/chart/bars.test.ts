/**
 * @fileoverview A bar chart drawn from a tally: a bar per value, the largest
 * first, each its share of the largest, its value at the tip and the file's
 * text for its label. A plot holds as many as fit, and a line counts the rest,
 * and another says when a column holds more values than a tally keeps apart.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import { DISTINCT_AT_MOST } from "@engine";
import type { Group, Groups } from "@engine";
import { m } from "@paraglide/messages";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { SPAN_LEAST, TIP_GAP, bars, fitTips } from "@renderer/chart/bars";
import { num } from "@renderer/locale";
import { holding } from "../charted.ts";

const REGION = { col: 1, header: "region" };
const ROWS = { t: "bars", by: REGION } as const;
const SUMS = { ...ROWS, sum: { col: 5, header: "revenue" } };

/** A tally of `groups` alone. */
function tallyOf(...groups: Group[]): Groups {
  const none = { values: 0, rows: 0, sum: 0 };
  return { groups, others: none, below: none, rest: none, skipped: { blank: 0, unparsed: 0 } };
}

const REGIONS = tallyOf(
  { value: "North", rows: 1204, sum: 48160.5 },
  { value: "South", rows: 812, sum: 32480 },
  { value: "West", rows: 301, sum: 0 },
);

/** Five values, the largest first. */
const FIVE = tallyOf(
  ...[50, 40, 30, 20, 10].map((rows, i) => ({ value: `v${i + 1}`, rows, sum: 0 })),
);

/** A plot that holds every region. */
const TALL = holding(REGIONS.groups.length);

/** The line that counts the values and rows a plot leaves out. */
const rest = (values: number, rows: number): string =>
  `${m.chart_bars_more({ count: num(values) })} · ${m.rows_count({ count: rows })}`;

const all = (box: HTMLElement, selector: string): HTMLElement[] => [
  ...box.querySelectorAll<HTMLElement>(selector),
];
const texts = (box: HTMLElement, selector: string): Array<string | null> =>
  all(box, selector).map((at) => at.textContent);
const labels = (box: HTMLElement): Array<string | null> => texts(box, ".chart-bar-label");
const tips = (box: HTMLElement): Array<string | null> => texts(box, ".chart-bar-tip");
const lines = (box: HTMLElement): Array<string | null> => texts(box, ".chart-bars-line");
const shares = (box: HTMLElement): number[] =>
  all(box, ".chart-bar-track").map((track) => Number(track.style.getPropertyValue("--share")));
const property = (box: HTMLElement, name: string): string => box.style.getPropertyValue(name);

/** The width a page gives a value here, in px. */
const TIP_PX = 30;

/** Lays out each of `box`'s `selector` as a page would, `width` px wide. */
function widen(box: HTMLElement, selector: string, width: number): void {
  for (const at of all(box, selector)) {
    Object.defineProperty(at, "getBoundingClientRect", { value: () => new DOMRect(0, 0, width) });
  }
}

/** The regions of a column of more values than a tally keeps apart. */
const PAST = {
  ...REGIONS,
  others: { values: DISTINCT_AT_MOST - REGIONS.groups.length, rows: 20_000, sum: 0 },
  rest: { rows: 500, sum: 0 },
};

afterEach(() => {
  void setLocale(baseLocale, { reload: false });
});

test("rows per value draw in the tally's order, each its share of the largest", () => {
  const box = bars(ROWS, REGIONS, TALL);
  expect(labels(box)).toStrictEqual(["North", "South", "West"]);
  expect(tips(box)).toStrictEqual(["1,204", "812", "301"]);
  expect(shares(box)).toStrictEqual([1, 812 / 1204, 301 / 1204]);
});

test("a sum per value draws each value's sum, and a sum of nothing no bar", () => {
  const box = bars(SUMS, REGIONS, TALL);
  expect(tips(box)).toStrictEqual(["48,160.5", "32,480", "0"]);
  expect(shares(box)).toStrictEqual([1, 32480 / 48160.5, 0]);
  expect(shares(bars(SUMS, tallyOf({ value: "", rows: 1, sum: 0 }), TALL))).toStrictEqual([0]);
});

test("a sum below zero draws left of zero, on the scale of the sums above it", () => {
  const signed = tallyOf(
    { value: "North", rows: 3, sum: 300 },
    { value: "South", rows: 2, sum: -100 },
  );
  const box = bars(SUMS, signed, TALL);
  expect(property(box, "--zero")).toBe(`${100 / 400}`);
  expect(shares(box)).toStrictEqual([300 / 400, 100 / 400]);
  expect(all(box, ".chart-bar-track.below")).toStrictEqual([all(box, ".chart-bar-track")[1]]);
  expect(tips(box)).toStrictEqual(["300", "-100"]);
  expect([property(box, "--room-above"), property(box, "--room-below")]).toStrictEqual([
    "calc(3ch + var(--tip-gap))",
    "calc(4ch + var(--tip-gap))",
  ]);
});

test("sums all above zero or all below leave no room past zero, but a sum of nothing keeps its own", () => {
  expect(property(bars(SUMS, REGIONS, TALL), "--room-below")).toBe("0px");
  const under = bars(SUMS, tallyOf({ value: "", rows: 2, sum: -5 }), TALL);
  expect([property(under, "--zero"), property(under, "--room-above")]).toStrictEqual(["1", "0px"]);
  const nothing = tallyOf({ value: "a", rows: 1, sum: 0 }, { value: "b", rows: 2, sum: -5 });
  expect(property(bars(SUMS, nothing, TALL), "--room-above")).toBe("calc(1ch + var(--tip-gap))");
});

test("values that would leave the bars under SPAN_LEAST of their track give way to the bars", () => {
  const signed = tallyOf({ value: "a", rows: 1, sum: 300 }, { value: "b", rows: 1, sum: -100 });
  // Draws `signed` in tracks `track` px wide, each value TIP_PX wide, and fits it.
  const fitted = (track: number): HTMLElement => {
    const box = bars(SUMS, signed, TALL);
    widen(box, ".chart-bar-track", track);
    widen(box, ".chart-bar-tip", TIP_PX);
    fitTips(box);
    return box;
  };
  const needs = 2 * (TIP_PX + TIP_GAP) + SPAN_LEAST;
  expect(tips(fitted(needs))).toStrictEqual(["300", "-100"]);
  const narrow = fitted(needs - 1);
  const rooms = ["--room-above", "--room-below"].map((side) => property(narrow, side));
  expect([tips(narrow), rooms]).toStrictEqual([[], ["0px", "0px"]]);
  // A plot not laid out yet keeps its values, to fit them once it is.
  expect(tips(fitted(0))).toStrictEqual(["300", "-100"]);
});

test("a value's label is the file's text, marked as the file's, and never markup", () => {
  const markup = '<img src="x" onerror="alert(1)">';
  const one = tallyOf({ value: markup, rows: 3, sum: 0 });
  const [label] = all(bars(ROWS, one, TALL), ".chart-bar-label");
  expect([label?.tagName, label?.textContent]).toStrictEqual(["BDI", markup]);
  expect(label?.classList.contains("from-file")).toBe(true);
  expect(label?.querySelector("img")).toBeNull();
});

test("the bar of the rows with no value is labelled blank, the app's word in its language", () => {
  const unvalued = tallyOf({ value: "", rows: 3, sum: 0 });
  const [label] = all(bars(ROWS, unvalued, TALL), ".chart-bar-label");
  expect(label?.textContent).toBe(m.chart_blank_value());
  expect(label?.classList.contains("from-file")).toBe(false);
  void setLocale("es", { reload: false });
  expect(labels(bars(ROWS, unvalued, TALL))).toStrictEqual(["(en blanco)"]);
});

test("a plot draws the bars it holds, and the line of the rest takes a bar's row", () => {
  const every = bars(ROWS, FIVE, holding(FIVE.groups.length));
  expect([labels(every).length, lines(every)]).toStrictEqual([FIVE.groups.length, []]);

  const box = bars(ROWS, FIVE, holding(3));
  expect([labels(box), lines(box)]).toStrictEqual([["v1", "v2"], [rest(3, 60)]]);
  const short = bars(ROWS, FIVE, holding(3) - 1);
  expect([labels(short), lines(short)]).toStrictEqual([["v1"], [rest(4, 100)]]);
});

test("the line counts the values the tally did not send, above zero and at or below it", () => {
  const unsent = {
    ...REGIONS,
    others: { values: 40, rows: 900, sum: 120 },
    below: { values: 3, rows: 20, sum: -5 },
  };
  const box = bars(SUMS, unsent, holding(REGIONS.groups.length + 1));
  expect(labels(box)).toStrictEqual(["North", "South", "West"]);
  expect(lines(box)).toStrictEqual([rest(43, 920)]);
  expect(labels(bars(SUMS, unsent, holding(REGIONS.groups.length)))).toHaveLength(2);
  const under = bars(SUMS, { ...REGIONS, below: unsent.below }, holding(REGIONS.groups.length + 1));
  expect(lines(under)).toStrictEqual([rest(3, 20)]);
});

test("values past the ones a tally keeps apart add a line that says so, each line whole in its title", () => {
  const box = bars(ROWS, PAST, holding(REGIONS.groups.length + 2));
  const kept = m.chart_bars_past({ count: num(DISTINCT_AT_MOST) });
  expect(lines(box)).toStrictEqual([rest(PAST.others.values, 20_500), kept]);
  expect(all(box, ".chart-bars-line").map((at) => at.title)).toStrictEqual(lines(box));
  const short = bars(ROWS, PAST, holding(REGIONS.groups.length + 1));
  expect([labels(short), lines(short)]).toStrictEqual([
    ["North", "South"],
    [rest(9_998, 20_801), kept],
  ]);
});

test("the values and the lines are written in the app's language", () => {
  void setLocale("es", { reload: false });
  const box = bars(SUMS, PAST, holding(3));
  expect(tips(box)).toStrictEqual(["48.160,5"]);
  expect(lines(box)).toStrictEqual([
    "+9999 más · 21.613 filas",
    "más de 10.000 valores · los demás se cuentan en el resto",
  ]);
});
