/**
 * @fileoverview A chord chart's table and summary: its square, a row per node
 * it runs from and a column per node it runs to, Other last, each row's total,
 * and lines of the rows Other counts past the fold's bounds; and a sentence of
 * its largest flow, then each node with what it runs to the others.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { ChordPlot } from "@document";
import type { ChordTally } from "@engine";
import { flowed } from "@renderer/chart/summary";
import { squared } from "@renderer/chart/table";

const PLOT: ChordPlot = {
  t: "chord",
  from: { col: 0, header: "origin" },
  to: { col: 1, header: "dest" },
};
const SKIPPED = { blank: 0, unparsed: 0 };

/** A tally of ORD, a blank cell's node and Other, each flow its rows. */
const TALLY: ChordTally = {
  t: "chord",
  plot: PLOT,
  coverage: { rows: 1_212, total: 1_212, complete: true },
  nodes: ["ORD", ""],
  flows: [
    [0, 1_204, 3],
    [980, 0, 1],
    [20, 2, 2],
  ].map((out) => out.map((rows) => ({ rows, sum: 0 }))),
  others: 4,
  unsplit: 0,
  rest: { rows: 0, sum: 0 },
  skipped: SKIPPED,
};

/** lines gives a table's rows as their cells' words. */
const lines = ([heads, rows]: [HTMLElement[], HTMLElement[]]) => [
  heads.map((h) => h.textContent).join(" | "),
  ...rows.map((r) => [...r.children].map((c) => c.textContent).join(" | ")),
];

test("a chord chart's table lists its square, from in rows and to in columns, Other last, with each row's total", () => {
  expect(lines(squared(PLOT, TALLY))).toStrictEqual([
    "origin | ORD | (blank) | Other | total",
    "ORD | 0 | 1,204 | 3 | 1,207",
    "(blank) | 980 | 0 | 1 | 981",
    "Other | 20 | 2 | 2 | 24",
  ]);
  const past = { ...TALLY, unsplit: 3, rest: { rows: 1, sum: 0 } };
  expect(lines(squared(PLOT, past)).slice(-2)).toStrictEqual([
    "rows past 20,000 pairs are in Other",
    "more than 10,000 values · later ones are counted in the rest",
  ]);
});

test("a chord chart's summary says its largest flow, then each node with what it runs to the others", () => {
  expect(flowed(PLOT, TALLY)).toStrictEqual({
    span: "The largest flow is ORD to (blank), 1,204.",
    each: ["ORD 1,207", "(blank) 981", "Other 24"],
    more: 0,
  });
});
