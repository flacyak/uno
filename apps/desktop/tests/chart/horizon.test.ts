/**
 * @fileoverview A horizon chart's drawing: three bands of one round scale,
 * each folded into its row over the last, and below zero the same in the
 * pole's steps, under a legend of the bands' breaks, over their periods'
 * labels, and a line that counts the values left out; and its targets.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import {
  HORIZON_BANDS,
  HORIZON_ROWS_AT_MOST,
  horizonRows,
  horizonTargets,
} from "@renderer/chart/horizon";
import type { Horizon, Series } from "@renderer/chart/horizon";

/** A plot that holds every row, and the room it draws in. */
const TALL = 1_000;
const ROOM = { width: 420, ch: 7 };

/** No values left out, and the months of 2024. */
const NONE = { values: 0, rows: 0 };
const YEAR = { per: "month", from: 648, span: 12 } as const;

/** horizonOf gives a horizon of `series` over 2024's months, none left out. */
const horizonOf = (series: Series[]): Horizon => ({ periods: YEAR, series, others: NONE });

/** rowsOf draws `series` of rows, none left out, in a tall plot. */
const rowsOf = (series: Series[]): HTMLElement => horizonRows(horizonOf(series), false, ROOM, TALL);

/** one gives a chart of one series of `amounts`. */
const one = (amounts: number[]): Series[] => [{ value: undefined, rows: 1, counts: [], amounts }];

/** Each row's bands' paths, the accent's first, then the pole's. */
const bandsOf = (drawn: HTMLElement): string[][] =>
  [...drawn.querySelectorAll(".chart-horizon-bands")].map((bands) =>
    [...bands.querySelectorAll("path")].map((p) => `${p.style.fill} ${p.getAttribute("d")}`),
  );

test("a horizon row folds its amounts into three bands of one scale, darker over lighter, and below zero in the pole's", () => {
  // The most is 6, so each band is 2: 6 fills all three, 3 one and a half, -2 the pole's first.
  const [row] = bandsOf(rowsOf(one([6, 3, -2])));
  expect(row).toHaveLength(2 * HORIZON_BANDS);
  expect(row!.slice(0, HORIZON_BANDS)).toEqual([
    "var(--seq-2) M0 1V0H1V0H2V1H3V1Z",
    "var(--seq-3) M0 1V0H1V0.5H2V1H3V1Z",
    "var(--seq-4) M0 1V0H1V1H2V1H3V1Z",
  ]);
  expect(row![HORIZON_BANDS]).toBe("var(--div-2) M0 1V1H1V1H2V0H3V1Z");
  expect(bandsOf(rowsOf(one([0])))).toEqual([
    [
      "var(--seq-2) M0 1V1H1V1Z",
      "var(--seq-3) M0 1V1H1V1Z",
      "var(--seq-4) M0 1V1H1V1Z",
      "var(--div-2) M0 1V1H1V1Z",
      "var(--div-3) M0 1V1H1V1Z",
      "var(--div-4) M0 1V1H1V1Z",
    ],
  ]);
});

test("a horizon chart draws a row per value with its name, every row on one scale, at most twelve", () => {
  const drawn = rowsOf([
    { value: "North", rows: 6, counts: [6], amounts: [6] },
    { value: "South", rows: 3, counts: [3], amounts: [3] },
  ]);
  const [north, south] = bandsOf(drawn);
  expect(north![0]).toBe("var(--seq-2) M0 1V0H1V1Z");
  // South's 3 on North's scale of 2 a band: the first band full, the second half.
  expect(south!.slice(0, 2)).toEqual(["var(--seq-2) M0 1V0H1V1Z", "var(--seq-3) M0 1V0.5H1V1Z"]);
  expect([...drawn.querySelectorAll(".chart-bar-label")].map((l) => l.textContent)).toEqual([
    "North",
    "South",
  ]);
  const many = Array.from({ length: HORIZON_ROWS_AT_MOST + 2 }, (_, i) => ({
    value: `v${i}`,
    rows: i,
    counts: [i],
    amounts: [i],
  }));
  expect(bandsOf(rowsOf(many))).toHaveLength(HORIZON_ROWS_AT_MOST);
  expect(rowsOf(one([1])).querySelector(".chart-bar-label")).toBeNull();
});

/** legendOf gives a drawing's legend: its swatches' fills, and its breaks. */
const legendOf = (drawn: HTMLElement): string[][] => [
  [...drawn.querySelectorAll<HTMLElement>(".chart-swatch")].map((s) =>
    s.style.getPropertyValue("--fill"),
  ),
  [...drawn.querySelectorAll(".chart-scale .chart-tick")].map((t) => t.textContent ?? ""),
];

test("a horizon chart's bands are round, and its legend keys each band's step with the breaks between them", () => {
  // The most is 5, so a band of 5 / 3 rounds up to 2: 5 fills two bands and half the third.
  const drawn = rowsOf(one([5]));
  expect(bandsOf(drawn)[0]![2]).toBe("var(--seq-4) M0 1V0.5H1V1Z");
  expect(legendOf(drawn)).toEqual([
    ["var(--seq-2)", "var(--seq-3)", "var(--seq-4)"],
    ["0", "2", "4", "6"],
  ]);
  const signed = legendOf(horizonRows(horizonOf(one([6, -2])), true, ROOM, TALL));
  expect(signed[0]).toEqual([
    "var(--div-4)",
    "var(--div-3)",
    "var(--div-2)",
    "var(--seq-2)",
    "var(--seq-3)",
    "var(--seq-4)",
  ]);
  // "-6" and its neighbours do not stand apart over 24 px swatches, so the legend writes the ends and zero.
  expect(signed[1]).toEqual(["-6", "0", "6"]);
});

test("a horizon chart counts the values it leaves out and their rows, sent and not", () => {
  const many = Array.from({ length: HORIZON_ROWS_AT_MOST + 2 }, (_, i) => ({
    value: `v${i}`,
    rows: 2,
    counts: [2],
    amounts: [1],
  }));
  const drawn = horizonRows(
    { ...horizonOf(many), others: { values: 1, rows: 4 } },
    false,
    ROOM,
    TALL,
  );
  expect(drawn.querySelector(".chart-bars-line")?.textContent).toBe("+3 more · 8 rows");
  expect(rowsOf(many.slice(0, 2)).querySelector(".chart-bars-line")).toBeNull();
});

test("a horizon chart names its periods under its rows, as many as stand apart, and one of one series spans the plot", () => {
  const ticks = (drawn: HTMLElement) =>
    [...drawn.querySelectorAll(".chart-heat-periods .chart-tick")].map((t) => t.textContent);
  expect(
    ticks(rowsOf([{ value: "North", rows: 1, counts: [], amounts: Array<number>(12).fill(1) }])),
  ).toEqual(["Jan 2024", "Mar", "May", "Jul", "Sep", "Nov"]);
  const alone = rowsOf(one(Array<number>(12).fill(1)));
  expect(alone.classList).toContain("alone");
  expect(ticks(alone)).toHaveLength(6);
});

test("a horizon chart's periods each say their value, their period and what they hold, and the keys step along a value and across values", () => {
  // Two regions' sums over January to March 2024, and their rows.
  const horizon: Horizon = {
    periods: { per: "month", from: 648, span: 3 },
    series: [
      { value: "North", rows: 10, counts: [8, 0, 2], amounts: [80, 0, -20] },
      { value: "South", rows: 5, counts: [1, 4, 0], amounts: [10, 40, 0] },
    ],
    others: NONE,
  };
  const targets = horizonTargets(horizon, true, horizonRows(horizon, true, ROOM, TALL));
  const said = (n: number) =>
    targets.all[n]!.said()
      .map(({ value, label }) => `${value} ${label.textContent}`)
      .join(" / ");
  expect(said(2)).toBe("-20 North, March 2024 / 2 rows");
  expect(said(4)).toBe("40 South, February 2024 / 4 rows");
  // 80 reaches the third band of 30, -20 the pole's first, and an empty period wears the rule.
  expect([0, 1, 2].map((n) => targets.all[n]!.key)).toEqual([
    "var(--seq-4)",
    "var(--rule)",
    "var(--div-2)",
  ]);
  const step = (key: string, at: number | undefined) => targets.step!(key, at);
  expect([
    step("ArrowRight", undefined),
    step("ArrowRight", 2),
    step("ArrowDown", 1),
    step("End", 3),
  ]).toEqual([0, 2, 4, 5]);
  const alone = { ...horizon, series: horizon.series.slice(0, 1) };
  alone.series[0] = { ...alone.series[0]!, value: undefined };
  const once = horizonTargets(alone, false, horizonRows(alone, false, ROOM, TALL));
  expect(once.all[0]!.said().map(({ value, label }) => `${value} ${label.textContent}`)).toEqual([
    "8 January 2024",
  ]);
});
