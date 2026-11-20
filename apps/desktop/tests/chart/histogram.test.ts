/**
 * @fileoverview A histogram's columns drawn from one level of its spread: a
 * slot per bin, its span filling the plot's width and the bins past it to
 * each side beyond its edges, in a scroller that first shows the span.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Level } from "@tally";
import { COLUMN_PITCH_LEAST } from "@renderer/chart/columns";
import { binnedIn, histogram } from "@renderer/chart/histogram";
import { ROOM } from "../charted.ts";

/** Ten bins 10 wide from 0, the span the middle six: ticked 0 to 8 by 2. */
const TENS: Level = {
  step: 1,
  power: 1,
  first: 0,
  rows: [1, 0, 4, 8, 6, 2, 3, 2, 0, 1],
  at: 2,
  spans: 6,
  below: 0,
  above: 0,
};

/** A level of `spans` bins of one row, all of them its span. */
const flat = (spans: number, power: number): Level => ({
  ...TENS,
  power,
  rows: Array.from({ length: spans }, () => 1),
  at: 0,
  spans,
});

test("each bin has a slot, its column its rows' share of an axis from zero", () => {
  const box = histogram({ level: TENS, fits: true });
  const slots = [...box.querySelectorAll<HTMLElement>(".chart-periods > .chart-period")];
  const shares = slots.map((slot) => slot.style.getPropertyValue("--share"));
  expect(shares).toStrictEqual([
    "0.125",
    "0",
    "0.5",
    "1",
    "0.75",
    "0.25",
    "0.375",
    "0.25",
    "0",
    "0.125",
  ]);
  expect(box.querySelectorAll(".chart-period .chart-column")).toHaveLength(TENS.rows.length);
});

test("the span fills the scroller's width, and the bins past it stand beyond its edges", () => {
  const box = histogram({ level: TENS, fits: true });
  const along = box.querySelector<HTMLElement>(".chart-along")!;
  expect(along.classList.contains("chart-scrolls")).toBe(true);
  // A scroller is no stop of its own for the keys, which the plot has.
  expect(along.tabIndex).toBe(-1);
  const periods = along.querySelector<HTMLElement>(".chart-periods")!;
  expect(periods.style.width).toBe(`${(TENS.rows.length / TENS.spans) * 100}%`);
  expect(box.style.getPropertyValue("--span-at")).toBe(`${TENS.at / TENS.spans}`);
});

test("a histogram draws the finest level whose span's bins each get their least pitch", () => {
  const across = ROOM.width;
  const fine = flat(Math.ceil(across / COLUMN_PITCH_LEAST) + 1, 0);
  const coarse = flat(Math.floor(across / COLUMN_PITCH_LEAST / 2), 1);
  expect(binnedIn([fine, coarse], ROOM)).toStrictEqual({ level: coarse, fits: true });
  const narrow = { ...ROOM, width: COLUMN_PITCH_LEAST };
  expect(binnedIn([fine, coarse], narrow)).toStrictEqual({ level: coarse, fits: false });
  expect(binnedIn([], ROOM)).toBeUndefined();
});
