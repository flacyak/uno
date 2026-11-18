/**
 * @fileoverview A stacked bar chart drawn from a tally: a bar per value, the
 * largest first, split into a segment per series in slot order, then Other,
 * parts above zero rightward and below it leftward, with the net at the tip.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { StackPlot } from "@document";
import type { StackTally } from "@engine";
import { keyOf, stack } from "@renderer/chart/stack";
import type { SplitValue } from "@tally";
import { holding } from "../charted.ts";

const ROWS: StackPlot = {
  t: "stack",
  by: { col: 1, header: "region" },
  split: { col: 3, header: "channel" },
};
const SUMS: StackPlot = { ...ROWS, sum: { col: 5, header: "revenue" } };

/** A cell of `rows` rows summing to `sum`. */
const cell = (rows: number, sum = 0) => ({ rows, sum });

/** A value of `cells`, then `other`, with their total. */
function valued(
  value: string,
  cells: Array<{ rows: number; sum: number }>,
  other = cell(0),
): SplitValue {
  const total = [...cells, other].reduce((a, b) => cell(a.rows + b.rows, a.sum + b.sum));
  return { value, cells, other, total };
}

/** A tally of `values` over `series`. */
function tallyOf(series: string[], ...values: SplitValue[]): StackTally {
  const none = { values: 0, rows: 0, sum: 0 };
  return {
    t: "stack",
    plot: ROWS,
    coverage: { rows: 0, total: 0, complete: true },
    series,
    values,
    others: none,
    below: none,
    rest: { rows: 0, sum: 0 },
    unsplit: 0,
    skipped: { blank: 0, unparsed: 0 },
  };
}

const all = (box: HTMLElement, selector: string): HTMLElement[] => [
  ...box.querySelectorAll<HTMLElement>(selector),
];
const property = (at: HTMLElement, name: string): string => at.style.getPropertyValue(name);
/** Each bar's segments, as their colour, start and length. */
const segments = (box: HTMLElement) =>
  all(box, ".chart-bar-track").map((track) =>
    all(track, ".chart-segment").map((s) => [
      property(s, "--key"),
      Number(property(s, "--from")),
      Number(property(s, "--part")),
    ]),
  );
/** Each bar's segments, as their colour, side, start and length. */
const sided = (box: HTMLElement) =>
  all(box, ".chart-bar-track").map((track) =>
    all(track, ".chart-segment").map((s) => [
      property(s, "--key"),
      s.classList.contains("above") ? "above" : "under",
      Number(property(s, "--from")),
      Number(property(s, "--part")),
    ]),
  );
const tips = (box: HTMLElement) => all(box, ".chart-bar-tip").map((tip) => tip.textContent);

const TALL = holding(3);

test("each bar's segments run in slot order from zero, then Other, each its share of the longest bar", () => {
  const tally = tallyOf(
    ["web", "direct"],
    valued("North", [cell(6), cell(3)], cell(1)),
    valued("South", [cell(0), cell(5)]),
  );
  const box = stack(ROWS, tally, TALL);
  expect(segments(box)).toStrictEqual([
    [
      ["var(--chart-1)", 0, 0.6],
      ["var(--chart-2)", 0.6, 0.3],
      ["var(--ink-3)", 0.9, 0.1],
    ],
    [["var(--chart-2)", 0, 0.5]],
  ]);
  expect(tips(box)).toStrictEqual(["10", "5"]);
  // The first segment of a side meets zero, and only the last is round.
  const north = all(box, ".chart-bar-track")[0]!;
  const classes = all(north, ".chart-segment").map((s) => [
    s.classList.contains("after"),
    s.classList.contains("end"),
  ]);
  expect(classes).toStrictEqual([
    [false, false],
    [true, false],
    [true, true],
  ]);
});

test("a sum per value and series draws each value's sum, and a part of nothing no segment", () => {
  const tally = tallyOf(
    ["web", "direct"],
    valued("North", [cell(2, 4.5), cell(1, 0)], cell(1, 1.5)),
  );
  const box = stack(SUMS, tally, TALL);
  expect(segments(box)).toStrictEqual([
    [
      ["var(--chart-1)", 0, 0.75],
      ["var(--ink-3)", 0.75, 0.25],
    ],
  ]);
  expect(tips(box)).toStrictEqual(["6"]);
  expect(box.style.getPropertyValue("--room-above")).toBe("calc(1ch + var(--tip-gap))");
});

test("a value's parts below zero stack leftward, and its net total stands at the tip of its side", () => {
  const tally = tallyOf(
    ["web", "returns", "direct"],
    valued("North", [cell(2, 300), cell(1, -100), cell(1, 100)]),
    valued("South", [cell(1, 50), cell(1, -250), cell(0)]),
  );
  const box = stack(SUMS, tally, TALL);
  // 250 below zero and 400 above it share one scale of 650.
  const span = 650;
  expect(box.style.getPropertyValue("--zero")).toBe(`${250 / span}`);
  expect(sided(box)).toStrictEqual([
    [
      ["var(--chart-1)", "above", 0, 300 / span],
      ["var(--chart-3)", "above", 300 / span, 100 / span],
      ["var(--chart-2)", "under", 0, 100 / span],
    ],
    [
      ["var(--chart-1)", "above", 0, 50 / span],
      ["var(--chart-2)", "under", 0, 250 / span],
    ],
  ]);
  expect(tips(box)).toStrictEqual(["300", "-200"]);
  // The first part under zero parts from the first above it by the gap.
  const gapped = all(box, ".chart-segment.under").map((s) => s.classList.contains("after"));
  expect(gapped).toStrictEqual([true, true]);
  const tracks = all(box, ".chart-bar-track");
  expect(tracks.map((t) => t.classList.contains("below"))).toStrictEqual([false, true]);
  expect(tracks.map((t) => Number(property(t, "--share")))).toStrictEqual([400 / span, 250 / span]);
  expect([
    box.style.getPropertyValue("--room-above"),
    box.style.getPropertyValue("--room-below"),
  ]).toStrictEqual(["calc(3ch + var(--tip-gap))", "calc(4ch + var(--tip-gap))"]);
});

test("slot i wears the i-th chart colour, and past the series Other's ink", () => {
  expect([0, 5, 6].map((i) => keyOf(i, 6))).toStrictEqual([
    "var(--chart-1)",
    "var(--chart-6)",
    "var(--ink-3)",
  ]);
  expect(keyOf(2, 2)).toBe("var(--ink-3)");
});

test("a plot holds as many bars as rows fit, and a line counts the rest", () => {
  const values = ["a", "b", "c", "d"].map((v) => valued(v, [cell(1)]));
  const box = stack(ROWS, tallyOf(["web"], ...values), TALL);
  expect(all(box, ".chart-bar-label").map((l) => l.textContent)).toStrictEqual(["a", "b"]);
  expect(all(box, ".chart-bars-line")).toHaveLength(1);
});
