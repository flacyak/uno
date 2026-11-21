/**
 * @fileoverview A chord chart's ring of a tally: an arc per node, and Other,
 * clockwise from the top in slot order, each its node's share of the flows
 * out and in, in its slot's colour, Other in the caption's ink, and placed at
 * the size the ring stands at, ARC_WIDTH thick and ARC_GAP from the next.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { ChordPlot } from "@document";
import type { ChordTally } from "@engine";
import {
  ARC_GAP,
  ARC_LEAST,
  ARC_WIDTH,
  arcs,
  chord,
  fitRing,
  ribbons,
} from "@renderer/chart/chord";
import type { Ribbon } from "@renderer/chart/chord";
import { chord as kind } from "@renderer/chart/kinds/chord";
import { OTHER_KEY } from "@renderer/chart/pie";

const ROWS: ChordPlot = {
  t: "chord",
  from: { col: 0, header: "origin" },
  to: { col: 1, header: "dest" },
};
const SUMS: ChordPlot = { ...ROWS, sum: { col: 2, header: "seats" } };
const WHOLE = { rows: 1, total: 1, complete: true };
/** How wide a fitted ring stands, in px. */
const ACROSS = 200;

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
  expect(kind(ROWS).drawing(none, { width: 0, ch: 0 })?.empty).toBe(true);
});

/** `ribbons` with every turn and share in fourteenths, rounded to a millionth of one. */
function inFourteenths(ribbons: Ribbon[]): Ribbon[] {
  const fourteenths = 14;
  const places = 6;
  const of = (turn: number) => Number((turn * fourteenths).toFixed(places));
  return ribbons.map((r) => ({
    ...r,
    ends: [
      [of(r.ends[0][0]), of(r.ends[0][1])],
      [of(r.ends[1][0]), of(r.ends[1][1])],
    ],
    share: of(r.share),
  }));
}

test("a chord's ribbons stand on both arcs as wide as the flow both ways, in the busier sender's colour, the widest first, a flow to itself folded on its arc", () => {
  // ORD's arc holds LAX's ribbon first, its nearest before it, then JFK's, its nearest after it.
  expect(inFourteenths(ribbons(ROWS, AIRPORTS))).toStrictEqual([
    {
      places: [0, 1],
      ends: [
        [1, 6],
        [6, 11],
      ],
      share: 5,
      key: "var(--chart-1)",
    },
    {
      places: [0, 2],
      ends: [
        [0, 1],
        [13, 14],
      ],
      share: 1,
      key: "var(--chart-1)",
    },
    {
      places: [2, 2],
      ends: [
        [11, 12],
        [12, 13],
      ],
      share: 1,
      key: "var(--chart-3)",
    },
  ]);
});

test("a ribbon wears the colour of the place that sends more of it, the earlier on a tie, Other's its ink", () => {
  const tally = tallyOf(
    ["ORD", "JFK"],
    [
      [0, 1, 0],
      [2, 0, 1],
      [0, 3, 0],
    ],
  );
  const worn = ribbons(ROWS, tally).map(({ places, key }) => [places, key]);
  expect(worn).toStrictEqual([
    [[2, 1], OTHER_KEY],
    [[1, 0], "var(--chart-2)"],
  ]);
  const tied = tallyOf(
    ["ORD", "JFK"],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 0],
    ],
  );
  expect(ribbons(ROWS, tied).map(({ places }) => places)).toStrictEqual([[0, 1]]);
  expect(
    ribbons(
      ROWS,
      tallyOf(
        ["ORD"],
        [
          [0, 0],
          [0, 0],
        ],
      ),
    ),
  ).toStrictEqual([]);
});

/** The ring `tally` draws, fitted as a ring `across` px wide. */
function fitted(tally: ChordTally, across: number): HTMLElement {
  const box = chord(ROWS, tally);
  const ring = box.querySelector(".chart-chord-ring")!;
  Object.defineProperty(ring, "getBoundingClientRect", { value: () => ({ width: across }) });
  fitRing(box);
  return box;
}

/** The start and end of an arc's rim, and the radius of its inner edge, as `d` writes them. */
function rimOf(d: string): { start: [number, number]; end: [number, number]; inner: number } {
  const [, ...xs] = /^M(\S+) (\S+)A\S+ \S+ 0 [01] 1 (\S+) (\S+)L\S+ \S+A(\S+) /u
    .exec(d)!
    .map(Number);
  return { start: [xs[0]!, xs[1]!], end: [xs[2]!, xs[3]!], inner: xs[4]! };
}

test("a fitted ring's arcs are ARC_WIDTH thick at its rim, ARC_GAP apart where they meet, and a ring of one node is whole", () => {
  const across = ACROSS;
  const box = fitted(AIRPORTS, across);
  const ring = box.querySelector(".chart-chord-ring")!;
  expect(ring.getAttribute("viewBox")).toBe("-100 -100 200 200");
  const rims = [...box.querySelectorAll(".chart-chord-arc")].map((arc) =>
    rimOf(arc.getAttribute("d")!),
  );
  expect(rims).toHaveLength(3);
  // A tenth of a px either way, as a path rounds each point to a hundredth.
  const close = 1;
  for (const [i, rim] of rims.entries()) {
    expect(Math.hypot(...rim.start)).toBeCloseTo(across / 2, close);
    expect(rim.inner).toBe(across / 2 - ARC_WIDTH);
    const next = rims[(i + 1) % rims.length]!;
    expect(Math.hypot(next.start[0] - rim.end[0], next.start[1] - rim.end[1])).toBeCloseTo(
      ARC_GAP,
      close,
    );
  }
  const one = tallyOf(
    ["ORD"],
    [
      [1, 0],
      [0, 0],
    ],
  );
  const whole = fitted(one, ACROSS).querySelector(".chart-chord-arc")!.getAttribute("d");
  expect(whole).toBe(
    "M0 -100A100 100 0 1 1 0 100A100 100 0 1 1 0 -100ZM0 -90A90 90 0 1 1 0 90A90 90 0 1 1 0 -90Z",
  );
});

test("an arc too short to keep its colour beside its gaps keeps its whole length", () => {
  // At ACROSS px, ARC_LEAST is this share of the rim, and LAX's arc is about half of it.
  const share = ARC_LEAST / (Math.PI * ACROSS);
  const big = Math.round(1 / share);
  const tally = tallyOf(
    ["ORD", "LAX"],
    [
      [big, 0, 0],
      [1, 0, 0],
      [0, 0, 0],
    ],
  );
  const [, lax] = [...fitted(tally, ACROSS).querySelectorAll(".chart-chord-arc")];
  const { start } = rimOf(lax!.getAttribute("d")!);
  // LAX starts right where ORD's share ends, with no half gap taken.
  const turn = (2 * big + 1) / (2 * big + 2);
  const close = 1;
  expect(start[0]).toBeCloseTo((ACROSS / 2) * Math.sin(2 * Math.PI * turn), close);
});

test("a chord not laid out yet places no arc, to place them once it is", () => {
  const arc = fitted(AIRPORTS, 0).querySelector(".chart-chord-arc")!;
  expect(arc.getAttribute("d")).toBeNull();
});
