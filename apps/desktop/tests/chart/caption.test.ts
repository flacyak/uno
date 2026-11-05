/**
 * @fileoverview What a chart's caption says of how much of its source it has
 * read, in the language chosen: the share read while its tally is partial, and
 * the rows once it is complete.
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { GroupsTally } from "@engine";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { coverage } from "@renderer/chart/caption";
import { BARS } from "../charted.ts";

/** The sales export's rows, and how many of them a tally two fifths through has read. */
const ROWS = 4812;
const READ = 1925;

/** The no-break space Intl writes between a number and its unit, so a label never wraps there. */
const NBSP = " ";

/** A tally of BARS that has read `rows` of `total`, complete once it has read every row. */
function tallyOf(rows: number, total: number, complete = rows === total): GroupsTally {
  const none = { values: 0, rows: 0, sum: 0 };
  return {
    t: "groups",
    plot: BARS.plot,
    coverage: { rows, total, complete },
    groups: [],
    others: none,
    below: none,
    rest: none,
    skipped: { blank: 0, unparsed: 0 },
  };
}

afterEach(() => void setLocale(baseLocale, { reload: false }));

test("the caption says the share read while a tally is partial, and the rows once it is complete", () => {
  expect(coverage(tallyOf(READ, ROWS))).toBe("partial · 40% read");
  expect(coverage(tallyOf(ROWS, ROWS))).toBe("4,812 rows");
  expect(coverage(tallyOf(1, 1))).toBe("1 row");
  void setLocale("es", { reload: false });
  expect(coverage(tallyOf(READ, ROWS))).toBe(`parcial · 40${NBSP}% leído`);
  expect(coverage(tallyOf(ROWS, ROWS))).toBe("4812 filas");
});

test("the share read is of the rows the index estimates, which the rows read can run past, and a source of no rows has none", () => {
  expect(coverage(tallyOf(6, 5, false))).toBe("partial · 100% read");
  expect(coverage(tallyOf(0, 0, false))).toBe("partial · 0% read");
});

test("the caption says nothing of the source before a tally, or of one the chart could not read", () => {
  expect(coverage(undefined)).toBe("");
  const said = { t: "chart-column-gone", header: "region", name: "sales-q3.csv" } as const;
  expect(coverage({ t: "unread", plot: BARS.plot, said })).toBe("");
});
