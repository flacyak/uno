/**
 * @fileoverview A chart's table, drawn from a tally: a row per value sent, the
 * largest first, with what it measures in the app's language, the values a
 * tally sent none of counted after them, and a line for the values past those
 * a tally keeps apart. Its caption says what the chart is called, its headers
 * name the columns, and the file's text is marked as the file's.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import { DISTINCT_AT_MOST } from "@engine";
import type { Group, GroupsTally } from "@engine";
import { m } from "@paraglide/messages";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { table } from "@renderer/chart/table";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { BARS, PIE, SHARES } from "../charted.ts";

/** A sum of revenue per region. */
const SUMS = { ...BARS.plot, sum: { col: 5, header: "revenue" } };

/** A value sent of `rows` rows, whose cells sum to `sum`. */
const sent = (value: string, rows: number, sum = rows): Group => ({ value, rows, sum });

/** A complete tally of `groups` alone. */
function tallyOf(...groups: Group[]): GroupsTally {
  const none = { values: 0, rows: 0, sum: 0 };
  return {
    t: "groups",
    plot: BARS.plot,
    coverage: { rows: 1, total: 1, complete: true },
    groups,
    others: none,
    below: none,
    rest: none,
    skipped: { blank: 0, unparsed: 0 },
  };
}

/** What the head calls the chart, as the table's caption. */
const called = (): HTMLElement => el("bdi", "", "Rows per region");

/** The rows of `box`'s table, as each cell's text. */
const rows = (box: HTMLElement): string[][] =>
  [...box.querySelectorAll("tr")].map((tr) => [...tr.children].map((cell) => cell.textContent));

afterEach(() => void setLocale(baseLocale, { reload: false }));

test("a table has a row per value sent, the largest first, its value heading the row and its rows in the app's language", () => {
  const tally = tallyOf(sent("North", 1204), sent("South", 812));
  const box = table(BARS.plot, tally, called());
  expect(box.classList.contains("chart-scrolls")).toBe(true);
  expect(box.querySelector("table > caption")?.textContent).toBe("Rows per region");
  expect(rows(box)).toStrictEqual([
    ["region", "rows"],
    ["North", "1,204"],
    ["South", "812"],
  ]);
  const [head, first] = [...box.querySelectorAll("tr")];
  expect(
    [...head!.children].map((th) => `${th.tagName} ${th.getAttribute("scope")}`),
  ).toStrictEqual(["TH col", "TH col"]);
  expect(head!.querySelector(".from-file")?.textContent).toBe("region");
  expect(first!.firstElementChild?.getAttribute("scope")).toBe("row");
  expect(first!.querySelector("th .from-file")?.textContent).toBe("North");
  void setLocale("es", { reload: false });
  expect(rows(table(BARS.plot, tally, called()))).toStrictEqual([
    ["region", "filas"],
    ["North", "1204"],
    ["South", "812"],
  ]);
});

test("a sum's column is headed by the column summed, a blank value is called blank, and each number is in the digits' column", () => {
  const box = table(SUMS, tallyOf(sent("", 3, 450.5), sent("North", 1, -20)), called());
  expect(rows(box)).toStrictEqual([
    ["region", "revenue"],
    [m.chart_blank_value(), "450.5"],
    ["North", "-20"],
  ]);
  expect(box.querySelectorAll("thead .from-file")).toHaveLength(2);
  expect(box.querySelector("tbody tr:first-child th .from-file")).toBeNull();
  expect([...box.querySelectorAll("td")].every((td) => td.classList.contains("num"))).toBe(true);
});

test("the values a tally sent none of are one row after the sent ones, and a line says when later values are counted in the rest", () => {
  const unsent = { values: 5, rows: 20, sum: 100 };
  const past = { rows: 7, sum: 1 };
  const tally = { ...tallyOf(sent("North", 2)), others: unsent, below: unsent, rest: past };
  const box = table(BARS.plot, tally, called());
  expect(rows(box)).toStrictEqual([
    ["region", "rows"],
    ["North", "2"],
    [m.chart_bars_more({ count: "10" }), "47"],
    [m.chart_bars_past({ count: num(DISTINCT_AT_MOST) })],
  ]);
  expect(box.querySelector("tbody tr:last-child td")?.getAttribute("colspan")).toBe("2");
  expect(rows(table(SUMS, tally, called())).at(2)).toStrictEqual([
    m.chart_bars_more({ count: "10" }),
    "201",
  ]);
  expect(rows(table(BARS.plot, tallyOf(sent("North", 2)), called()))).toHaveLength(2);
});

test("a pie's table gives each value's share of the pie's whole, and none to a value at or below zero", () => {
  const sums = tallyOf(sent("North", 2, 300), sent("South", 1, 100), sent("West", 1, -50));
  expect(rows(table(SHARES.plot, sums, called()))).toStrictEqual([
    ["region", "revenue", "share"],
    ["North", "300", "75%"],
    ["South", "100", "25%"],
    ["West", "-50", ""],
  ]);
  // Every value's rows are above zero, so each has a share.
  const unsent = { values: 5, rows: 20, sum: 0 };
  const seven = [20, 10, 10, 10, 10, 10, 10].map((n, i) => sent(`v${i + 1}`, n));
  const counts = { ...tallyOf(...seven), others: unsent };
  const shares = rows(table(PIE.plot, counts, called())).map((cells) => cells.at(-1));
  expect(shares).toStrictEqual(["share", "20%", "10%", "10%", "10%", "10%", "10%", "10%", "20%"]);
});

test("the row of the values sent none of has the share Other draws of them, and none where the pie draws no Other", () => {
  // Other takes the values past those a tally keeps apart only where they come
  // to more than zero, and never the values at or below zero, so the shares
  // add up to the pie's whole: 900 in six slices and 200 in Other.
  const seven = [300, 200, 100, 100, 100, 100, 100].map((n, i) => sent(`v${i + 1}`, 1, n));
  const netted = {
    ...tallyOf(...seven),
    others: { values: 10, rows: 10, sum: 100 },
    below: { values: 5, rows: 5, sum: -80 },
    rest: { rows: 20, sum: -300 },
  };
  const more = m.chart_bars_more({ count: "15" });
  expect(rows(table(SHARES.plot, netted, called())).at(-2)).toStrictEqual([more, "-280", "9.1%"]);
  const few = { ...tallyOf(...seven.slice(0, 3)), rest: { rows: 50, sum: 1000 } };
  const two = { ...few, others: { values: 2, rows: 2, sum: 50 } };
  expect(rows(table(SHARES.plot, two, called())).at(-2)).toStrictEqual([
    m.chart_bars_more({ count: "2" }),
    "1,050",
    "",
  ]);
});
