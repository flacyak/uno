/**
 * @fileoverview A beeswarm's packing: dots placed by rank nearest each strip's
 * middle, above and below in turn, never overlapping and stopping at a prefix
 * when a strip fills, and at most eight strips sharing the plot's rows.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { SwarmPlot } from "@document";
import type { SwarmTally } from "@engine";
import {
  DOT,
  STRIPS_AT_MOST,
  pack,
  packed,
  swarm as drawSwarm,
  tallOf,
} from "@renderer/chart/swarm";
import { swarm } from "@renderer/chart/kinds/swarm";
import type { Strip } from "@tally";

const OF = { col: 1, header: "amount" };
const BY = { col: 0, header: "region" };
const PLOT: SwarmPlot = { t: "swarm", of: OF, by: BY };
const ROOM = { width: 420, ch: 7 };
const TALL = 600;
/** A short plot's height, which holds five rows. */
const LEAST = 160;
/** How far a dot's middle may stand off a strip's of two rows. */
const REACH = (tallOf(2) - DOT) / 2;

/** stripOf is a strip of `value` whose sampled rows hold `at`. */
function stripOf(value: string, at: number[], plotted = at.length): Strip {
  return { value, plotted, rows: at.map((_, i) => i), at };
}

/** tallyOf is a beeswarm's tally of `strips`, over 0 to 100. */
function tallyOf(strips: Strip[], plotted = 1_000): SwarmTally {
  const coverage = { rows: plotted, total: plotted, complete: true };
  const skipped = { blank: 0, unparsed: 0 };
  return { t: "swarm", plot: PLOT, coverage, strips, plotted, least: 0, most: 100, skipped };
}

test("dots at one number stack from the middle, above then below, and stop when the strip is full", () => {
  expect(
    pack(
      Array.from({ length: 10 }, () => 50),
      REACH,
    ),
  ).toStrictEqual([0, -DOT, DOT, -2 * DOT, 2 * DOT]);
});

test("packed dots never overlap, stand within the strip, and are a prefix of the sample", () => {
  const xs = Array.from({ length: 128 }, (_, i) => (i * 37) % 300);
  const ys = pack(xs, REACH);
  expect(ys.length).toBeGreaterThan(0);
  for (const [i, y] of ys.entries()) {
    expect(Math.abs(y)).toBeLessThanOrEqual(REACH);
    for (let j = 0; j < i; j++) {
      const apart = Math.hypot(xs[i]! - xs[j]!, y - ys[j]!);
      expect(apart).toBeGreaterThanOrEqual(DOT - 1e-9);
    }
  }
});

test("a beeswarm draws at most eight strips and a line for the rest, fewer where the plot is short", () => {
  const strips = Array.from({ length: STRIPS_AT_MOST + 2 }, (_, i) => stripOf(`r${i}`, [i, 50]));
  const tally = tallyOf(strips);
  const tall = packed(tally, undefined, ROOM, TALL);
  expect(tall.map((p) => p.label)).toStrictEqual(
    strips.slice(0, STRIPS_AT_MOST).map((s) => s.value),
  );
  expect(tall.flatMap((p) => p.dots.map((d) => d.at))).toStrictEqual(
    strips.slice(0, STRIPS_AT_MOST).flatMap((s) => s.at.map((x) => x / 100)),
  );
  // The least plot holds four rows past its axis's: a strip of three, and the line.
  expect(packed(tally, undefined, ROOM, LEAST).map((p) => p.rows)).toStrictEqual([3]);
  // Strips share the rows the plot holds, two at least.
  expect(
    packed(tallyOf(strips.slice(0, 1)), undefined, ROOM, LEAST).map((p) => p.rows),
  ).toStrictEqual([4]);
  expect(tall.every((p) => p.rows === 2)).toBe(true);
  // A beeswarm of no column of values names its one strip for its numbers, and Other is last.
  const rest = stripOf("", [1]);
  expect(packed(tallyOf([], 1), "amount", ROOM, TALL).map((p) => p.label)).toStrictEqual([]);
  expect(
    packed({ ...tallyOf([strips[0]!]), rest }, undefined, ROOM, TALL).map((p) => p.label),
  ).toStrictEqual(["r0", "Other"]);
});

test("a beeswarm draws a strip of its dots per value, a line for the strips left out, and its axis", () => {
  const strips = Array.from({ length: STRIPS_AT_MOST + 2 }, (_, i) => stripOf(`r${i}`, [i, 50]));
  const tally = tallyOf(strips);
  const drawn = drawSwarm(packed(tally, undefined, ROOM, TALL), tally);
  expect(drawn.querySelectorAll(".chart-swarm-track")).toHaveLength(STRIPS_AT_MOST);
  expect(drawn.querySelectorAll(".chart-swarm-dot")).toHaveLength(2 * STRIPS_AT_MOST);
  expect(drawn.querySelector(".chart-bars-line")?.textContent).toBe("+2 more");
  const ticks = [...drawn.querySelectorAll(".chart-tick")].map((t) => t.textContent);
  expect(ticks).toStrictEqual(["0", "50", "100"]);
  expect(swarm(PLOT).drawing(tallyOf([], 0), ROOM)?.empty).toBe(true);
  expect(swarm({ t: "swarm", of: OF }).title()).toBe("amount");
  expect(swarm(PLOT).title()).toBe("amount per region");
});

test("a beeswarm's caption counts the dots it drew of every row, as a sample, and nothing when it drew every row", () => {
  const drawing = swarm(PLOT).drawing(tallyOf([stripOf("North", [10, 20, 30])]), ROOM)!;
  drawing.draw(TALL);
  expect(drawing.notes()).toStrictEqual(["3 of 1,000 rows, a sample"]);
  const whole = swarm(PLOT).drawing(tallyOf([stripOf("North", [10, 20, 30])], 3), ROOM)!;
  whole.draw(TALL);
  expect(whole.notes()).toStrictEqual([]);
});
