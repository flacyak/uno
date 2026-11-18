/**
 * @fileoverview A stacked chart's table and summary: a column per series in
 * slot order, Other and the total, a row per value sent and one for the
 * values left out, and a sentence that names the column that splits the bars.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { StackPlot } from "@document";
import type { StackTally } from "@engine";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { summaryOf } from "@renderer/chart/summary";
import { el } from "@renderer/shell/util";
import { PAIRS_AT_MOST } from "@tally";
import { ROOM, kindFor } from "../charted.ts";

afterEach(async () => {
  await setLocale(baseLocale, { reload: false });
});

/** Revenue per region by channel: two regions in web, a blank channel and Other, and three regions left out. */
const PLOT: StackPlot = {
  t: "stack",
  by: { col: 1, header: "region" },
  split: { col: 3, header: "channel" },
  sum: { col: 5, header: "revenue" },
};
const cell = (rows: number, sum: number) => ({ rows, sum });
const TALLY: StackTally = {
  t: "stack",
  plot: PLOT,
  coverage: { rows: 20, total: 20, complete: true },
  series: ["web", ""],
  values: [
    {
      value: "North",
      cells: [cell(3, 300), cell(2, 50.5)],
      other: cell(1, -20),
      total: cell(6, 330.5),
    },
    { value: "", cells: [cell(1, 10), cell(0, 0)], other: cell(0, 0), total: cell(1, 10) },
  ],
  others: { values: 2, rows: 8, sum: 80 },
  below: { values: 1, rows: 5, sum: -5 },
  rest: { rows: 0, sum: 0 },
  unsplit: 0,
  skipped: { blank: 0, unparsed: 0 },
};

/** The text of each row of `table`, cell by cell. */
const rowsOf = (table: HTMLElement): string[][] =>
  [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((cell) => cell.textContent ?? ""),
  );

test("the table's columns are the series in slot order, Other and the total, a row per value, then the values left out", () => {
  const drawing = kindFor(PLOT).drawing(TALLY, ROOM)!;
  expect(
    rowsOf(drawing.table(el("bdi", "", "sum of revenue per region by channel"))),
  ).toStrictEqual([
    ["region", "web", "(blank)", "Other", "total"],
    ["North", "300", "50.5", "-20", "330.5"],
    ["(blank)", "10", "0", "0", "10"],
    ["+3 more", "", "75"],
  ]);
  const heads = drawing.table(el("span")).querySelectorAll("thead .from-file");
  expect([...heads].map((h) => h.textContent)).toStrictEqual(["region", "web"]);
});

test("the summary names the column that splits the bars, how many series it draws, and the values by their totals", async () => {
  const told = kindFor(PLOT).drawing(TALLY, ROOM)!.told();
  const summary = summaryOf("sum of revenue per region by channel", "sales.csv", 20, told);
  expect(summary.said).toBe(
    "sum of revenue per region by channel in sales.csv, 20 rows. Split by channel into 3 series.",
  );
  expect(summary.values).toBe("North 330.5, (blank) 10");
  expect(summary.more).toBe("and 3 more.");
  await setLocale("es", { reload: false });
  expect(kindFor(PLOT).drawing(TALLY, ROOM)!.told().span).toBe("Dividido por channel en 3 series.");
});

test("the caption says when rows past the pairs a tally keeps are in Other, and not before", () => {
  expect(kindFor(PLOT).drawing(TALLY, ROOM)!.notes()).toStrictEqual([]);
  const past = kindFor(PLOT)
    .drawing({ ...TALLY, unsplit: 4 }, ROOM)!
    .notes();
  expect(past).toStrictEqual([
    `rows past ${PAIRS_AT_MOST.toLocaleString("en-US")} pairs are in Other`,
  ]);
});
