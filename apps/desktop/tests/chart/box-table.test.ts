/**
 * @fileoverview A box plot's table: each row's numbers, R's five, mean and
 * rows past its whiskers, then the cells left out.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { BoxTally } from "@engine";
import { boxedRows } from "@renderer/chart/box";
import { boxed, tableOf } from "@renderer/chart/table";
import { el } from "@renderer/shell/util";
import type { Box } from "@tally";

const AMOUNT = { col: 1, header: "amount" };
const REGION = { col: 0, header: "region" };

/** A box of R's five `five`, with one row past its upper whisker. */
const boxOf = (five: number[]): Box => ({
  mean: five[2]!,
  five: five.map((n) => [n, n]),
  whiskers: [
    [five[0]!, five[0]!],
    [five[3]!, five[3]!],
  ],
  below: { rows: 0, buckets: [] },
  above: { rows: 1, buckets: [{ low: five[4]!, high: five[4]!, rows: 1 }] },
  span: [
    [five[0]!, five[0]!],
    [five[4]!, five[4]!],
  ],
});

const TALLY: BoxTally = {
  t: "box",
  plot: { t: "box", of: AMOUNT, by: REGION, span: "most" },
  coverage: { rows: 12, total: 12, complete: true },
  values: [
    {
      value: "South",
      spread: {
        numbers: 5,
        figures: "exact",
        box: boxOf([1, 2, 30, 40, 90]),
        skipped: { blank: 0, unparsed: 0 },
      },
    },
    {
      value: "",
      spread: {
        numbers: 4,
        figures: 3,
        box: boxOf([1, 2, 3, 4, 5]),
        skipped: { blank: 2, unparsed: 1 },
      },
    },
  ],
  skipped: { blank: 2, unparsed: 1 },
};

test("a box plot's table lists each row's numbers, R's five, mean and rows past its whiskers, then the cells left out", () => {
  const table = tableOf(
    boxed(boxedRows(TALLY, "amount"), REGION, TALLY),
    el("span", "", "amount per region"),
  );
  const lines = [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((cell) => cell.textContent).join(" | "),
  );
  expect(lines).toStrictEqual([
    "region | rows | least | lower hinge | median | upper hinge | most | mean | past whiskers",
    "South | 5 | 1 | 2 | 30 | 40 | 90 | 30 | 1",
    "(blank) | 4 | 1 | 2 | 3 | 4 | 5 | 3 | 1",
    "2 blank · 1 not a number",
  ]);
});
