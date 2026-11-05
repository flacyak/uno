/**
 * @fileoverview A bar chart drawn from a tally: a bar per value, the largest
 * first, each its share of the largest, its value at the tip and the file's
 * text for its label.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Group, Groups } from "@engine";
import { bars } from "@renderer/chart/bars";

const REGION = { col: 1, header: "region" };
const ROWS = { t: "bars", by: REGION } as const;
const SUMS = { ...ROWS, sum: { col: 5, header: "revenue" } };

/** A tally of `groups` alone. */
function tallyOf(...groups: Group[]): Groups {
  const none = { values: 0, rows: 0, sum: 0 };
  return { groups, others: none, below: none, rest: none, skipped: { blank: 0, unparsed: 0 } };
}

const REGIONS = tallyOf(
  { value: "North", rows: 1204, sum: 48160.5 },
  { value: "South", rows: 812, sum: 32480 },
  { value: "West", rows: 301, sum: 0 },
);

const all = (box: HTMLElement, selector: string): HTMLElement[] => [
  ...box.querySelectorAll<HTMLElement>(selector),
];
const texts = (box: HTMLElement, selector: string): Array<string | null> =>
  all(box, selector).map((at) => at.textContent);
const labels = (box: HTMLElement): Array<string | null> => texts(box, ".chart-bar-label");
const tips = (box: HTMLElement): Array<string | null> => texts(box, ".chart-bar-tip");
const shares = (box: HTMLElement): number[] =>
  all(box, ".chart-bar-track").map((track) => Number(track.style.getPropertyValue("--share")));

test("rows per value draw in the tally's order, each its share of the largest", () => {
  const box = bars(ROWS, REGIONS);
  expect(labels(box)).toStrictEqual(["North", "South", "West"]);
  expect(tips(box)).toStrictEqual(["1,204", "812", "301"]);
  expect(shares(box)).toStrictEqual([1, 812 / 1204, 301 / 1204]);
});

test("a sum per value draws each value's sum, and a sum of nothing no bar", () => {
  const box = bars(SUMS, REGIONS);
  expect(tips(box)).toStrictEqual(["48,160.5", "32,480", "0"]);
  expect(shares(box)).toStrictEqual([1, 32480 / 48160.5, 0]);
  expect(shares(bars(SUMS, tallyOf({ value: "", rows: 1, sum: 0 })))).toStrictEqual([0]);
});

test("a value's label is the file's text, marked as the file's, and never markup", () => {
  const markup = '<img src="x" onerror="alert(1)">';
  const one = tallyOf({ value: markup, rows: 3, sum: 0 });
  const [label] = all(bars(ROWS, one), ".chart-bar-label");
  expect([label?.tagName, label?.textContent]).toStrictEqual(["BDI", markup]);
  expect(label?.classList.contains("from-file")).toBe(true);
  expect(label?.querySelector("img")).toBeNull();
});
