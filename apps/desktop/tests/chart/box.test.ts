/**
 * @fileoverview A box plot's rows: each value's box, highest median first,
 * then Other's, or a column's one box.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { BoxTally } from "@engine";
import { m } from "@paraglide/messages";
import { boxedRows, boxes } from "@renderer/chart/box";
import { rowsIn } from "@renderer/chart/rows";
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

/** A plot's height in px, of more rows than a few boxes take. */
const TALL = 300;

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

/** The marks of each row `boxes` draws, as each's kind and its --from and --to. */
const marks = (box: HTMLElement): string[][] =>
  [...box.querySelectorAll(".chart-box-track")].map((track) =>
    [...track.children].map(
      (at) =>
        `${at.className} ${(at as HTMLElement).style.getPropertyValue("--from")} ${(at as HTMLElement).style.getPropertyValue("--to")}`,
    ),
  );

test("a box stands from hinge to hinge, its median across it and its whiskers to their ends, on one axis", () => {
  const spread: Box = {
    ...boxAt(0),
    five: [
      [0, 0],
      [20, 20],
      [30, 30],
      [60, 60],
      [100, 100],
    ],
    whiskers: [
      [10, 10],
      [80, 80],
    ],
    span: [
      [0, 0],
      [100, 100],
    ],
  };
  const box = boxes([{ label: "West", box: spread }], false, TALL);
  expect(marks(box)).toStrictEqual([
    ["chart-whisker 0.1 0.8", "chart-box 0.2 0.6", "chart-median 0.3 0.3"],
  ]);
  expect(box.querySelector(".chart-bar-label")!.textContent).toBe("West");
});

test("a mark past the span stands at its edge, and the rows a plot cannot hold are left out", () => {
  const wide: Box = {
    ...boxAt(50),
    whiskers: [
      [-500, -500],
      [900, 900],
    ],
    span: [
      [0, 0],
      [100, 100],
    ],
  };
  expect(marks(boxes([{ label: "a", box: wide }], false, TALL))[0]![0]).toBe("chart-whisker 0 1");
  const many = Array.from({ length: 40 }, (_, i) => ({ label: `${i}`, box: boxAt(i) }));
  expect(boxes(many, false, TALL).querySelectorAll(".chart-box-track").length).toBeLessThan(
    rowsIn(TALL),
  );
});

test("a number past a whisker is a ring, the axis is labelled under the rows, and a line says how many rows are left out", () => {
  const past: Box = {
    ...boxAt(50),
    span: [
      [0, 0],
      [100, 100],
    ],
    above: { rows: 3, buckets: [{ low: 90, high: 90, rows: 3 }] },
  };
  const box = boxes([{ label: "a", box: past }], false, TALL);
  expect(marks(box)[0]!.at(-1)).toBe("chart-past 0.9 0.9");
  const ticks = [...box.querySelectorAll(".chart-box-axis .chart-tick")].map((t) => t.textContent);
  expect(ticks).toStrictEqual(["0", "50", "100"]);
  const many = Array.from({ length: 40 }, (_, i) => ({ label: `${i}`, box: boxAt(i) }));
  const shown = rowsIn(TALL) - 2;
  const crowded = boxes(many, false, TALL);
  expect(crowded.querySelectorAll(".chart-box-track")).toHaveLength(shown);
  expect(crowded.querySelector(".chart-bars-line")!.textContent).toContain(
    `${many.length - shown}`,
  );
});

test("a box plot's axis reaches whole spans past its span, two at most each side, its span standing where the scroll starts", () => {
  const far: Box = {
    ...boxAt(50),
    five: [
      [-150, -150],
      [20, 20],
      [50, 50],
      [80, 80],
      [900, 900],
    ],
    span: [
      [0, 0],
      [100, 100],
    ],
    above: { rows: 1, buckets: [{ low: 900, high: 900, rows: 1 }] },
  };
  const along = boxes([{ label: "a", box: far }], false, TALL);
  const plot = along.querySelector<HTMLElement>(".chart-boxes")!;
  expect(along.classList.contains("chart-scrolls")).toBe(true);
  expect([
    plot.style.getPropertyValue("--spans"),
    plot.style.getPropertyValue("--span-at"),
  ]).toStrictEqual(["5", "2"]);
  const ticks = [...plot.querySelectorAll(".chart-box-axis .chart-tick")].map((t) => t.textContent);
  expect([ticks[0], ticks.at(-1)]).toStrictEqual(["-200", "300"]);
  expect(marks(plot)[0]!.at(-1)).toBe("chart-past 1 1");
  // Every number shows on an axis of its own, which reaches no further.
  const all = boxes([{ label: "a", box: far }], true, TALL).querySelector<HTMLElement>(
    ".chart-boxes",
  )!;
  expect(all.style.getPropertyValue("--spans")).toBe("1");
});
