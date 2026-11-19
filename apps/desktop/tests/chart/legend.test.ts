/**
 * @fileoverview A stacked chart's legend: a key per series in slot order, then
 * Other, in as many lines as its share of the plot holds, the rest counted.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import {
  ENTRY_GAP,
  KEY_GAP,
  KEY_SIZE,
  LEGEND_LINE,
  LEGEND_NAME_AT_MOST,
  LEGEND_SHARE_AT_MOST,
  legend,
} from "@renderer/chart/legend";
import type { Entry } from "@renderer/chart/legend";
import { BARS_INSET } from "@renderer/chart/rows";
import { keyOf } from "@renderer/chart/stack";

/** A mono character's width here, in px, as the window measures one. */
const CH = 6.6;

/** Eight series: six keys and Other, as a stack of more than six draws. */
const SERIES = ["web", "direct", "", "a".repeat(LEGEND_NAME_AT_MOST + 4), "mail", "phone"];
const ENTRIES: Entry[] = [
  ...SERIES.map((series, i) => ({ key: keyOf(i, SERIES.length), series })),
  { key: keyOf(SERIES.length, SERIES.length), series: undefined },
];

/** The width of a plot whose lines hold keys of `names` characters, and not one more. */
function across(...names: number[]): number {
  const keys = names.reduce((all, n) => all + KEY_SIZE + KEY_GAP + n * CH + ENTRY_GAP, 0);
  return keys - ENTRY_GAP + 2 * BARS_INSET;
}

const keys = (box: HTMLElement) =>
  [...box.querySelectorAll(".chart-legend-key")].map((k) =>
    (k as HTMLElement).style.getPropertyValue("--key"),
  );
const names = (box: HTMLElement) =>
  [...box.querySelectorAll(".chart-key-name")].map((n) => n.textContent);

test("a legend keys every series in slot order, then Other, each in its colour, the file's names apart from the app's", () => {
  const { box, height } = legend(ENTRIES, { width: 2_000, ch: CH }, 1_000);
  expect(keys(box)).toStrictEqual(
    [1, 2, 3, 4, 5, 6].map((i) => `var(--chart-${i})`).concat("var(--ink-3)"),
  );
  expect(names(box)).toStrictEqual([
    "web",
    "direct",
    "(blank)",
    SERIES[3],
    "mail",
    "phone",
    "Other",
  ]);
  expect([...box.querySelectorAll(".from-file")].map((n) => n.textContent)).toStrictEqual([
    "web",
    "direct",
    SERIES[3],
    "mail",
    "phone",
  ]);
  expect(box.querySelector(".chart-blank")?.textContent).toBe("(blank)");
  // A long name's key holds it whole in its title, and takes the room of LEGEND_NAME_AT_MOST.
  expect((box.children[3] as HTMLElement).title).toBe(SERIES[3]);
  expect(height).toBe(LEGEND_LINE + BARS_INSET);
});

test("keys wrap to the lines a plot's width holds", () => {
  // A line holds a cut name's key: web and direct, (blank), the long name,
  // mail and phone, then Other.
  const width = across(LEGEND_NAME_AT_MOST);
  expect(legend(ENTRIES, { width, ch: CH }, 1_000).height).toBe(5 * LEGEND_LINE + BARS_INSET);
});

test("a legend takes at most its share of the plot, and counts the keys it leaves out", () => {
  const width = across(3, 6);
  // Two lines' worth of LEGEND_SHARE_AT_MOST.
  const height = (2 * LEGEND_LINE) / LEGEND_SHARE_AT_MOST;
  const { box, height: taken } = legend(ENTRIES, { width, ch: CH }, height);
  expect(taken).toBe(2 * LEGEND_LINE + BARS_INSET);
  expect(names(box)).toStrictEqual(["web", "direct", "(blank)"]);
  expect(box.querySelector(".chart-key-more")?.textContent).toBe("+4 more");
});
