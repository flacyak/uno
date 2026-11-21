/**
 * @fileoverview A dot plot's table, which lists each value's measure, its
 * numbers and its rows, then the values and cells left out, and its summary,
 * which names its values largest first.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { DotsPlot } from "@document";
import type { MeanTally } from "@engine";
import { el } from "@renderer/shell/util";
import { ROOM, kindFor } from "../charted.ts";

const CARRIER = { col: 0, header: "carrier" };
const DAYS = { col: 1, header: "days" };
const MEANS: DotsPlot = { t: "dots", by: CARRIER, of: DAYS, measure: "mean" };

const TALLY: MeanTally = {
  t: "mean",
  plot: MEANS,
  coverage: { rows: 12, total: 12, complete: true },
  groups: [
    { value: "Acme", rows: 3, sum: 6.8, numbers: 2 },
    { value: "Bolt", rows: 2, sum: 3.1, numbers: 1 },
    { value: "Crane", rows: 2, sum: 6.4, numbers: 2 },
    { value: "Dart", rows: 2, sum: 5.8, numbers: 2 },
    { value: "", rows: 1, sum: 0, numbers: 0 },
  ],
  others: { values: 1, rows: 2, sum: 5 },
  below: { values: 0, rows: 0, sum: 0 },
  rest: { rows: 0, sum: 0 },
  skipped: { blank: 2, unparsed: 1 },
};

test("a dot plot's table lists each value's mean, numbers and rows, then the values and cells left out", () => {
  const drawing = kindFor(MEANS).drawing(TALLY, ROOM)!;
  const lines = [
    ...drawing.table(el("span", "", "mean of days per carrier")).querySelectorAll("tr"),
  ].map((tr) => [...tr.children].map((cell) => cell.textContent).join(" | "));
  expect(lines).toStrictEqual([
    "carrier | mean | numbers | rows",
    "Acme | 3.4 | 2 | 3",
    "Bolt | 3.1 | 1 | 2",
    "Crane | 3.2 | 2 | 2",
    "Dart | 2.9 | 2 | 2",
    "(blank) | no numbers | 0 | 1",
    "+1 more |  |  | 2",
    "2 blank · 1 not a number",
  ]);
});

test("a dot plot's table of a sum lists each value's sum and rows, and of rows its rows alone", () => {
  const table = (plot: DotsPlot) =>
    [
      ...kindFor(plot)
        .drawing({ ...TALLY, t: "groups", plot }, ROOM)!
        .table(el("span"))
        .querySelectorAll("tr"),
    ]
      .slice(0, 2)
      .map((tr) => [...tr.children].map((cell) => cell.textContent).join(" | "));
  expect(table({ t: "dots", by: CARRIER, of: DAYS, measure: "sum" })).toStrictEqual([
    "carrier | days | rows",
    "Acme | 6.8 | 3",
  ]);
  expect(table({ t: "dots", by: CARRIER })).toStrictEqual(["carrier | rows", "Acme | 3"]);
});

test("a dot plot's summary names its values, the highest first, each with its mean, and counts the rest", () => {
  const told = kindFor(MEANS).drawing(TALLY, ROOM)!.told();
  expect(told).toStrictEqual({
    span: "",
    each: ["Acme 3.4", "Bolt 3.1", "Crane 3.2", "Dart 2.9", "(blank) no numbers"],
    more: 3,
  });
});
