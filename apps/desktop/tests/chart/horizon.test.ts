/**
 * @fileoverview A horizon chart's drawing: three bands of one round scale,
 * each folded into its row over the last, and below zero the same in the
 * pole's steps, under a legend of the bands' breaks.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import { HORIZON_BANDS, HORIZON_ROWS_AT_MOST, horizonRows } from "@renderer/chart/horizon";
import type { Series } from "@renderer/chart/horizon";

/** A plot that holds every row, and the room it draws in. */
const TALL = 1_000;
const ROOM = { width: 420, ch: 7 };

/** rowsOf draws `series` of rows in a tall plot. */
const rowsOf = (series: Series[]): HTMLElement => horizonRows(series, false, ROOM, TALL);

/** one gives a chart of one series of `amounts`. */
const one = (amounts: number[]): Series[] => [{ value: undefined, amounts }];

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
    { value: "North", amounts: [6] },
    { value: "South", amounts: [3] },
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
  const signed = legendOf(horizonRows(one([6, -2]), true, ROOM, TALL));
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
