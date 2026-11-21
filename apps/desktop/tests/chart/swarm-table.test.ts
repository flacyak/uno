/**
 * @fileoverview A beeswarm's table and summary: each strip's sampled rows in
 * order of their number with their row, a line of the rows it left out, and
 * a sentence of its rows and their least and most, then its strips.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { SwarmPlot } from "@document";
import type { SwarmTally } from "@engine";
import { swarmOver } from "@renderer/chart/summary";
import { swarmed } from "@renderer/chart/table";

const OF = { col: 1, header: "amount" };
const BY = { col: 0, header: "region" };
const PLOT: SwarmPlot = { t: "swarm", of: OF, by: BY };
const COVERAGE = { rows: 7, total: 7, complete: true };
const SKIPPED = { blank: 0, unparsed: 0 };
const TALLY: SwarmTally = {
  t: "swarm",
  plot: PLOT,
  coverage: COVERAGE,
  strips: [{ value: "North", plotted: 5, rows: [4, 0, 2], at: [30, 10, 20] }],
  rest: { value: "", plotted: 1, rows: [6], at: [900] },
  plotted: 6,
  least: 10,
  most: 900,
  skipped: SKIPPED,
};

/** lines gives a table's rows as their cells' words. */
const lines = ([heads, rows]: [HTMLElement[], HTMLElement[]]) => [
  heads.map((h) => h.textContent).join(" | "),
  ...rows.map((r) => [...r.children].map((c) => c.textContent).join(" | ")),
];

test("a beeswarm's table lists each strip's sampled rows by their number, and the rows it did not sample", () => {
  expect(lines(swarmed(PLOT, TALLY))).toStrictEqual([
    "region | amount | row",
    "North | 10 | 1",
    "North | 20 | 3",
    "North | 30 | 5",
    "North | 2 rows not sampled",
    "Other | 900 | 7",
  ]);
  const alone = swarmed({ t: "swarm", of: OF }, { ...TALLY, rest: undefined });
  expect(lines(alone).slice(0, 2)).toStrictEqual(["amount | row", "10 | 1"]);
});

test("a beeswarm's summary says its rows, its least and most, and each strip's rows", () => {
  expect(swarmOver(PLOT, TALLY)).toStrictEqual({
    span: "6 rows, amount from 10 to 900.",
    each: ["North 5", "Other 1"],
    more: 0,
  });
  expect(swarmOver({ t: "swarm", of: OF }, TALLY).each).toStrictEqual([]);
});
