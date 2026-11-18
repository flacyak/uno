/**
 * @fileoverview Ranked rows: as many values as a plot's height has rows for,
 * the largest first, a line that counts the rest in a row of its own, and a
 * label that is the file's text or the app's word for a blank cell.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import { DISTINCT_AT_MOST } from "@engine";
import type { Group, Groups } from "@engine";
import { BARS_INSET, BAR_GAP, BAR_THICK, ranked, row } from "@renderer/chart/rows";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";

/** How many rows the plot below holds. */
const ROWS = 4;

/** A plot's height that holds ROWS rows exactly. */
const HEIGHT = 2 * BARS_INSET + ROWS * (BAR_THICK + BAR_GAP) - BAR_GAP;

/** How many values the tally below sends. */
const SENT = 10;

const none = { values: 0, rows: 0, sum: 0 };

/** A tally of SENT values, the largest first, each of its own count of rows. */
const groups = (rest = none): Groups => ({
  groups: Array.from({ length: SENT }, (_, i): Group => ({
    value: `v${i}`,
    rows: SENT - i,
    sum: 0,
  })),
  others: none,
  below: none,
  rest,
  skipped: { blank: 0, unparsed: 0 },
});

test("ranked rows hold as many values as the plot has rows for, the largest first, and a line that counts the rest takes a row", () => {
  const { shown, lines } = ranked(groups(), HEIGHT);
  expect(shown.map((g) => g.value)).toStrictEqual(["v0", "v1", "v2"]);
  const left = SENT - (ROWS - 1);
  const rowsLeft = (left * (left + 1)) / 2;
  expect(lines.map((line) => line.textContent)).toStrictEqual([
    `+${left} more · ${num(rowsLeft)} rows`,
  ]);
  expect(lines[0]!.title).toBe(lines[0]!.textContent);
});

test("ranked rows say in a line of its own that a tally has values past those it keeps apart", () => {
  const { shown, lines } = ranked(groups({ values: 0, rows: 5, sum: 0 }), HEIGHT);
  expect(shown).toHaveLength(ROWS - 2);
  expect(lines).toHaveLength(2);
  expect(lines[1]!.textContent).toContain(num(DISTINCT_AT_MOST));
});

test("a row's label is the file's text, or the app's word for a blank cell, and what the kind draws stands beside it", () => {
  const beside = el("div", "chart-bar-track");
  const named = row("North", beside);
  expect(named.className).toBe("chart-bar-row");
  expect(named.firstElementChild?.outerHTML).toBe(
    '<bdi class="chart-bar-label from-file">North</bdi>',
  );
  expect(named.lastElementChild).toBe(beside);
  const blank = row("", el("div")).firstElementChild!;
  expect(blank.className).toBe("chart-bar-label chart-blank");
  expect(blank.textContent).toBe("(blank)");
});
