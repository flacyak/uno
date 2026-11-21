/**
 * @fileoverview A week heatmap's title, table and summary: what it measures
 * per hour of the week, a row per hour from Sunday 00:00 under its day and
 * hour, then the rows with no date and the cells left out, and a sentence
 * that names the hour that holds the most.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { WeekPlot } from "@document";
import type { WeekTally } from "@engine";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { summaryOf } from "@renderer/chart/summary";
import { el } from "@renderer/shell/util";
import { DAY_HOURS, WEEK_HOURS } from "@tally";
import { ROOM, kindFor } from "../charted.ts";

afterEach(async () => {
  await setLocale(baseLocale, { reload: false });
});

/** Revenue per hour of the week of order_date: two rows on Monday at 13:00, one late on Saturday. */
const PLOT: WeekPlot = {
  t: "week",
  at: { col: 0, header: "order_date" },
  sum: { col: 5, header: "revenue" },
  order: "day",
};
const MONDAY_ONE = DAY_HOURS + 13;
const TALLY: WeekTally = {
  t: "week",
  plot: PLOT,
  coverage: { rows: 9, total: 9, complete: true },
  hours: Array.from({ length: WEEK_HOURS }, (_, i) =>
    i === MONDAY_ONE
      ? { rows: 2, sum: 300 }
      : i === WEEK_HOURS - 1
        ? { rows: 1, sum: -25.5 }
        : { rows: 0, sum: 0 },
  ),
  timed: 3,
  undated: { rows: 6, sum: 40 },
  dates: { blank: 2, unparsed: 4, other: 0 },
  skipped: { blank: 1, unparsed: 0 },
};

/** The text of each row of `table`, cell by cell, spaces as one. */
const rowsOf = (table: HTMLElement): string[][] =>
  [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((cell) => (cell.textContent ?? "").replace(/\s/gu, " ")),
  );

test("a week heatmap's title says what it measures per hour of the week of its dates", async () => {
  expect(kindFor(PLOT).title()).toBe("sum of revenue per hour of the week of order_date");
  expect(kindFor({ ...PLOT, sum: undefined }).title()).toBe(
    "rows per hour of the week of order_date",
  );
  await setLocale("es", { reload: false });
  expect(kindFor(PLOT).title()).toBe("suma de revenue por hora de la semana de order_date");
});

test("the table lists every hour of the week from Sunday 00:00 under its day and hour, then the rows with no date and the cells not added", () => {
  const drawing = kindFor(PLOT).drawing(TALLY, ROOM)!;
  const rows = rowsOf(drawing.table(el("bdi", "", "revenue per hour of the week")));
  expect(rows).toHaveLength(1 + WEEK_HOURS + 2);
  expect(rows[0]).toStrictEqual(["day", "hour", "rows", "revenue"]);
  expect(rows[1]).toStrictEqual(["Sunday", "12:00 AM", "0", "0"]);
  expect(rows[1 + MONDAY_ONE]).toStrictEqual(["Monday", "1:00 PM", "2", "300"]);
  expect(rows[WEEK_HOURS]).toStrictEqual(["Saturday", "11:00 PM", "1", "-25.5"]);
  expect(rows.slice(-2)).toStrictEqual([["no date", "6", "40"], ["1 blank"]]);
});

test("the summary names the week and the hour that holds the most, in the app's language", async () => {
  const told = kindFor(PLOT).drawing(TALLY, ROOM)!.told();
  const said = summaryOf("revenue per hour of the week", "sales.csv", 9, told).said.replace(
    /\s/gu,
    " ",
  );
  expect(said).toBe(
    "revenue per hour of the week in sales.csv, 9 rows. From Sunday to Saturday, the most in Monday, 1:00 PM to 2:00 PM: 300.",
  );
  await setLocale("pt-BR", { reload: false });
  expect(kindFor(PLOT).drawing(TALLY, ROOM)!.told().span).toBe(
    "De domingo a sábado, o máximo em segunda-feira, das 13:00 às 14:00: 300.",
  );
});

test("a week heatmap of plain dates lists a row per day, and its summary names the day with the most", () => {
  const days: WeekTally = {
    ...TALLY,
    timed: 0,
    hours: TALLY.hours.map((h, i) =>
      i === DAY_HOURS ? { rows: 2, sum: 300 } : { rows: 0, sum: 0 },
    ),
  };
  const drawing = kindFor(PLOT).drawing(days, ROOM)!;
  const rows = rowsOf(drawing.table(el("bdi", "", "revenue per day of the week")));
  expect(rows.slice(0, 3)).toStrictEqual([
    ["day", "rows", "revenue"],
    ["Sunday", "0", "0"],
    ["Monday", "2", "300"],
  ]);
  expect(rows).toHaveLength(1 + 7 + 2);
  expect(drawing.told().span).toBe("From Sunday to Saturday, the most in Monday: 300.");
  expect(drawing.kept?.()).toBe("drawn per day");
  expect(kindFor(PLOT).drawing(TALLY, ROOM)!.kept?.()).toBe("");
});
