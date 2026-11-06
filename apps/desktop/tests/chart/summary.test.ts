/**
 * @fileoverview What a chart says it shows, in the language chosen: its title,
 * its source and its rows, then the largest values with what each measures and
 * a count of the rest, or a scatter's points and what its axes span. The app's
 * words and the values from the file stand apart.
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { Group, GroupsTally, SampleTally } from "@engine";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { SUMMARY_VALUES, summary } from "@renderer/chart/summary";
import { madeTitle } from "@renderer/chart/window";
import { BARS, PIE, SCATTER } from "../charted.ts";

/** The sales export's file, and its rows. */
const NAME = "sales-q3.csv";
const ROWS = 4812;

/** A region's rows and the sum of its revenue. */
const sent = (value: string, rows: number, sum: number): Group => ({ value, rows, sum });

/** The export's regions, the largest first: one more than a summary names. */
const REGIONS = [
  sent("North", 2000, 7200),
  sent("South", 1500, 5000),
  sent("West", 1000, 2400),
  sent("East", 312, -600),
];

/** A complete tally of `groups`, over ROWS rows. */
function tallyOf(groups: Group[]): GroupsTally {
  const none = { values: 0, rows: 0, sum: 0 };
  return {
    t: "groups",
    plot: BARS.plot,
    coverage: { rows: ROWS, total: ROWS, complete: true },
    groups,
    others: none,
    below: none,
    rest: none,
    skipped: { blank: 0, unparsed: 0 },
  };
}

/** A sum of revenue per region. */
const SUMS = { ...BARS.plot, sum: { col: 5, header: "revenue" } };

/** A complete tally of the scatter over ROWS rows, which sent two of the points it plotted. */
const SAMPLE: SampleTally = {
  t: "sample",
  plot: SCATTER.plot,
  coverage: { rows: ROWS, total: ROWS, complete: true },
  x: [180, 999],
  y: [7200, 39960],
  plotted: 4808,
  least: { x: 1, y: 0 },
  most: { x: 2400, y: 1048000 },
  skipped: { blank: 4, unparsed: 0 },
};

afterEach(() => void setLocale(baseLocale, { reload: false }));

test("a summary says the title, the source and the rows, the largest values and how many more, in the language chosen", () => {
  const tally = tallyOf(REGIONS);
  expect(REGIONS.length).toBe(SUMMARY_VALUES + 1);
  expect(summary(madeTitle(BARS.plot), NAME, BARS.plot, tally)).toStrictEqual({
    said: "Rows per region in sales-q3.csv, 4,812 rows.",
    values: "North 2,000, South 1,500, West 1,000",
    more: "and 1 more.",
  });
  void setLocale("es", { reload: false });
  expect(summary(madeTitle(BARS.plot), NAME, BARS.plot, tally)).toStrictEqual({
    said: "Filas por region en sales-q3.csv, 4812 filas.",
    values: "North 2000, South 1500, West 1000",
    more: "y 1 más.",
  });
});

test("a sum names each value's sum, and the values a tally sent none of count among the rest", () => {
  const unsent = { values: 5, rows: 20, sum: 100 };
  const tally = { ...tallyOf(REGIONS), others: unsent, below: unsent };
  expect(summary("Where the money is", NAME, SUMS, tally)).toStrictEqual({
    said: "Where the money is in sales-q3.csv, 4,812 rows.",
    values: "North 7,200, South 5,000, West 2,400",
    more: "and 11 more.",
  });
});

test("a summary of fewer values than it names counts no more, and calls a blank value blank", () => {
  const tally = tallyOf([sent("", 3, 0), sent("North", 1, 0)]);
  expect(summary(madeTitle(BARS.plot), NAME, BARS.plot, tally)).toStrictEqual({
    said: "Rows per region in sales-q3.csv, 4,812 rows.",
    values: "(blank) 3, North 1",
    more: "",
  });
});

test("a pie's summary gives each slice's share, Other among them", () => {
  const seven = [80, 70, 60, 50, 40, 30, 20, 10].map((rows, i) => sent(`v${i + 1}`, rows, 0));
  const tally = tallyOf(seven);
  expect(summary(madeTitle(PIE.plot), NAME, PIE.plot, tally)).toStrictEqual({
    said: "Share of rows per region in sales-q3.csv, 4,812 rows.",
    values: "v1 22%, v2 19%, v3 17%",
    more: "and 4 more.",
  });
  const halved = tallyOf([sent("North", 2, 0), sent("South", 1, 0), sent("West", 1, 0)]);
  expect(summary(madeTitle(PIE.plot), NAME, PIE.plot, halved).values).toBe(
    "North 50%, South 25%, West 25%",
  );
});

test("a scatter's summary counts its points and spans both axes, with no values from the file apart", () => {
  expect(summary(madeTitle(SCATTER.plot), NAME, SCATTER.plot, SAMPLE)).toStrictEqual({
    said: "revenue against units in sales-q3.csv, 4,812 rows. 4,808 points, units from 1 to 2,400 and revenue from 0 to 1,048,000.",
    values: "",
    more: "",
  });
  void setLocale("es", { reload: false });
  expect(summary(madeTitle(SCATTER.plot), NAME, SCATTER.plot, SAMPLE).said).toBe(
    "revenue frente a units en sales-q3.csv, 4812 filas. 4808 puntos, units de 1 a 2400 y revenue de 0 a 1.048.000.",
  );
});
