/**
 * @fileoverview A histogram's table, summary and caption: each bin with its
 * rows and share, the rows under and over the bins, and the cells left out,
 * so every row is counted; the span, step, fullest bin and median said; and
 * the figures a coarsened spread holds.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { SpreadTally } from "@engine";
import type { Level } from "@tally";
import { binnedOver } from "@renderer/chart/summary";
import { binned, tableOf } from "@renderer/chart/table";
import { el } from "@renderer/shell/util";
import { ROOM, kindFor } from "../charted.ts";

const AMOUNT = { col: 2, header: "amount" };

/** Four bins 10 wide from 10, the middle two the span, with rows under and over them. */
const LEVEL: Level = {
  step: 1,
  power: 1,
  first: 1,
  rows: [2, 5, 3, 1],
  at: 1,
  spans: 2,
  below: 4,
  above: 5,
};

/** A tally of 20 numbers, two blank cells and one word, binned at LEVEL. */
const TALLY: SpreadTally = {
  t: "spread",
  plot: { t: "histogram", of: AMOUNT, span: "most" },
  coverage: { rows: 23, total: 23, complete: true },
  numbers: 20,
  figures: 3,
  box: {
    mean: 31,
    five: [
      [1, 1],
      [20, 20],
      [24.5, 24.6],
      [30, 30],
      [90, 90],
    ],
    whiskers: [
      [1, 1],
      [45, 45],
    ],
    below: 0,
    above: 2,
    span: [
      [10, 10],
      [35, 35],
    ],
  },
  levels: [LEVEL],
  skipped: { blank: 2, unparsed: 1 },
};

test("a histogram's table counts every row: each bin, those under and over the bins, and the cells left out", () => {
  const table = tableOf(binned(AMOUNT, TALLY, LEVEL), el("span", "", "rows per amount"));
  const lines = [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((cell) => cell.textContent).join(" | "),
  );
  expect(lines).toStrictEqual([
    "amount | rows | share",
    "under 10 | 4 | 20%",
    "10 to 20 | 2 | 10%",
    "20 to 30 | 5 | 25%",
    "30 to 40 | 3 | 15%",
    "40 to 50 | 1 | 5%",
    "50 and over | 5 | 25%",
    "2 blank · 1 not a number",
  ]);
});

test("a histogram's summary says its span, its step, its fullest bin of the span and its median", () => {
  expect(binnedOver(LEVEL, TALLY.box!).span).toBe(
    "From 20 to 40 in steps of 10, the most in 20 to 30: 5. Median 24.5.",
  );
});

test("a histogram's caption says the figures a coarsened spread holds, and nothing while exact", () => {
  const notes = (tally: SpreadTally) => kindFor(tally.plot).drawing(tally, ROOM)!.notes();
  expect(notes(TALLY)).toStrictEqual(["to 3 significant figures"]);
  expect(notes({ ...TALLY, figures: "exact" })).toStrictEqual([]);
});
