/**
 * @fileoverview An over-time chart's table and summary: its periods in time
 * order, an empty one too, then the rows with no date and the summed cells it
 * could not add, and a sentence that names the span and the period that holds
 * the most.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { TimePlot } from "@document";
import type { TimeTally } from "@engine";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { summaryOf } from "@renderer/chart/summary";
import { el } from "@renderer/shell/util";
import { ROOM, kindFor } from "../charted.ts";

afterEach(async () => {
  await setLocale(baseLocale, { reload: false });
});

/** Revenue per day of order_date, over four days from Sunday 3 March 2024, the third empty. */
const PLOT: TimePlot = {
  t: "time",
  at: { col: 0, header: "order_date" },
  sum: { col: 5, header: "revenue" },
  per: "day",
  order: "day",
};
const TALLY: TimeTally = {
  t: "time",
  plot: PLOT,
  coverage: { rows: 12, total: 12, complete: true },
  levels: [
    { per: "day", from: 19_785, span: 4, offset: 0, rows: [2, 4, 0, 1], sum: [150, 300, 0, 25.5] },
  ],
  undated: { rows: 5, sum: 40 },
  dates: { blank: 2, unparsed: 3, other: 0 },
  skipped: { blank: 1, unparsed: 0 },
};

/** The text of each row of `table`, cell by cell. */
const rowsOf = (table: HTMLElement): string[][] =>
  [...table.querySelectorAll("tr")].map((tr) => [...tr.children].map((cell) => cell.textContent));

test("the table lists every period sent in time order under its size, an empty one too, then the rows with no date and the cells not added", () => {
  const drawing = kindFor(PLOT).drawing(TALLY, ROOM)!;
  expect(rowsOf(drawing.table(el("bdi", "", "revenue per day of order_date")))).toStrictEqual([
    ["day", "rows", "revenue"],
    ["Mar 3, 2024", "2", "150"],
    ["Mar 4, 2024", "4", "300"],
    ["Mar 5, 2024", "0", "0"],
    ["Mar 6, 2024", "1", "25.5"],
    ["no date", "5", "40"],
    ["1 blank"],
  ]);
});

test("the summary names the span and the period that holds the most, in the app's language", async () => {
  const told = kindFor(PLOT).drawing(TALLY, ROOM)!.told();
  const said = summaryOf("revenue per day of order_date", "sales.csv", 12, told).said;
  expect(said).toBe(
    "revenue per day of order_date in sales.csv, 12 rows. From Sunday, March 3, 2024 to Wednesday, March 6, 2024, the most in Monday, March 4, 2024: 300.",
  );
  await setLocale("pt-BR", { reload: false });
  expect(kindFor(PLOT).drawing(TALLY, ROOM)!.told().span).toBe(
    "De domingo, 3 de março de 2024 a quarta-feira, 6 de março de 2024, o máximo em segunda-feira, 4 de março de 2024: 300.",
  );
});
