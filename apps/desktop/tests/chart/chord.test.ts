/**
 * @fileoverview A chord chart's ring of a tally: an arc per node, and Other,
 * clockwise from the top in slot order, each its node's share of the flows
 * out and in, in its slot's colour, Other in the caption's ink.
 */

import { expect, test } from "vite-plus/test";

import type { ChordPlot } from "@document";
import type { ChordTally } from "@engine";
import { arcs } from "@renderer/chart/chord";
import { OTHER_KEY } from "@renderer/chart/pie";

const ROWS: ChordPlot = {
  t: "chord",
  from: { col: 0, header: "origin" },
  to: { col: 1, header: "dest" },
};
const SUMS: ChordPlot = { ...ROWS, sum: { col: 2, header: "seats" } };
const WHOLE = { rows: 1, total: 1, complete: true };

/** A tally of `nodes` and Other, each flow its rows and ten times as many seats, or `sums` where given. */
function tallyOf(
  nodes: string[],
  rows: number[][],
  sums = rows.map((r) => r.map((n) => n * 10)),
): ChordTally {
  return {
    t: "chord",
    plot: ROWS,
    coverage: WHOLE,
    nodes,
    flows: rows.map((r, i) => r.map((n, j) => ({ rows: n, sum: sums[i]![j]! }))),
    others: 0,
    unsplit: 0,
    rest: { rows: 0, sum: 0 },
    skipped: { blank: 0, unparsed: 0 },
  };
}

/** ORD sends JFK 3 and LAX 1, JFK sends ORD 2, and LAX sends itself 1; Other sends and takes none. */
const AIRPORTS = tallyOf(
  ["ORD", "JFK", "LAX"],
  [
    [0, 3, 1, 0],
    [2, 0, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 0],
  ],
);

test("a chord's arcs run clockwise from the top in slot order, each its node's flows out and in, a flow to itself both", () => {
  // ORD 4 out and 2 in, JFK 2 and 3, LAX 1 and 1 of its own and 1 in: 14 in all.
  const whole = 14;
  expect(arcs(ROWS, AIRPORTS)).toStrictEqual([
    { place: 0, from: 0, to: 6 / whole, key: "var(--chart-1)" },
    { place: 1, from: 6 / whole, to: 11 / whole, key: "var(--chart-2)" },
    { place: 2, from: 11 / whole, to: 1, key: "var(--chart-3)" },
  ]);
});

test("Other's arc comes last in the caption's ink, and a flow at or below zero has no width", () => {
  const tally = tallyOf(
    ["ORD"],
    [
      [1, 1],
      [1, 1],
    ],
    [
      [-5, 2],
      [2, 4],
    ],
  );
  // ORD's flow to itself sums below zero, so its arc is its 2 out and 2 in, and Other's its 4 to itself twice.
  const whole = 16;
  expect(arcs(SUMS, tally)).toStrictEqual([
    { place: 0, from: 0, to: 4 / whole, key: "var(--chart-1)" },
    { place: 1, from: 4 / whole, to: 1, key: OTHER_KEY },
  ]);
  const none = tallyOf(
    ["ORD"],
    [
      [0, 0],
      [0, 0],
    ],
  );
  expect(arcs(ROWS, none)).toStrictEqual([]);
});
