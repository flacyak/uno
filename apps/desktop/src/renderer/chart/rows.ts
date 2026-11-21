/**
 * @fileoverview Ranked rows: a row per value, the largest first, its label in
 * a column the rows share, as many as a plot holds, and lines under them that
 * count the rest. A bar chart draws a bar in each row, and every kind that
 * draws a row per value lays its rows out the same way.
 */

import { DISTINCT_AT_MOST } from "@engine";
import type { Group, Groups } from "@engine";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import type { PlotRoom } from "./kind.ts";
import type { Targets } from "./tooltip.ts";

/** A row's thickness, in px: the dataviz skill's most for a bar. */
export const BAR_THICK = 24;

/** The window's ground between two rows, in px: the dataviz skill's gap. */
export const BAR_GAP = 2;

/**
 * The space around the rows, in px: as far in as the head's title and the
 * caption's words stand from the window's edge.
 */
export const BARS_INSET = 10;

/** The share of the plot the values' names take at most, and the gap after them. */
const NAMES_MOST = 0.4;
const NAMES_GAP = 8;

/** trackWide gives how wide the track beside rows of `values` stands in `room`, after their names. */
export function trackWide(values: readonly string[], room: PlotRoom): number {
  const inside = room.width - 2 * BARS_INSET;
  const longest = Math.max(0, ...values.map((value) => value.length));
  return inside - Math.min(longest * room.ch, NAMES_MOST * inside) - NAMES_GAP;
}

/** A row of a value, which a label heads, past an axis's row of labels. */
export const VALUE_ROWS = ".chart-bar-row:has(> .chart-bar-label)";

/** The values that get a row, the largest first, and the lines under them. */
export interface Ranked {
  shown: Group[];
  lines: HTMLElement[];
}

/** rowsIn gives how many rows of values or words a plot `height` px high holds. */
export function rowsIn(height: number): number {
  return Math.max(Math.floor((height - 2 * BARS_INSET + BAR_GAP) / (BAR_THICK + BAR_GAP)), 0);
}

/** line gives a line of `words` under the rows, whole in its title, as a narrow plot cuts it. */
function line(words: string): HTMLElement {
  const said = el("div", "chart-bars-line", words);
  said.title = words;
  return said;
}

/**
 * named gives a row's label: its value, the file's text, or the app's word for
 * the rows whose cell is blank, which a tally counts as a value of their own.
 */
function named(value: string): HTMLElement {
  if (value === "") return el("span", "chart-bar-label chart-blank", m.chart_blank_value());
  return el("bdi", "chart-bar-label from-file", value);
}

/**
 * ranked gives the values of `groups` a plot `height` px high holds a row for,
 * and the lines that count the rest, each taking a row: the values and rows
 * left, then that the values past those a tally keeps apart have more.
 */
export function ranked(groups: Groups, height: number): Ranked {
  const { others, below, rest } = groups;
  // The rest holds the rows of values past those a tally keeps apart, which it
  // cannot count, so a line of its own says there are more.
  const past = rest.rows > 0;
  const unsent = others.values + below.values > 0 || past;
  const rows = rowsIn(height) - (past ? 1 : 0);
  const all = groups.groups;
  const fit = all.length + (unsent ? 1 : 0) <= rows ? all.length : Math.max(rows - 1, 0);
  const lines: HTMLElement[] = [];
  const left = all.slice(fit);
  if (left.length > 0 || unsent) {
    const values = left.length + others.values + below.values;
    const rowsLeft = left.reduce((sum, g) => sum + g.rows, others.rows + below.rows + rest.rows);
    const more = m.chart_bars_more({ count: num(values) });
    lines.push(line(`${more} · ${m.rows_count({ count: rowsLeft })}`));
  }
  if (past) lines.push(line(m.chart_bars_past({ count: num(DISTINCT_AT_MOST) })));
  return { shown: all.slice(0, fit), lines };
}

/** row gives the row of `value`: its label, then what the kind draws `beside` it. */
export function row(value: string, beside: HTMLElement): HTMLElement {
  const made = el("div", "chart-bar-row");
  made.append(named(value), beside);
  return made;
}

/** The keys ranked rows' targets step past the tooltip's: to the next row and the one before. */
const ROWS_STEP = ["ArrowDown", "ArrowUp"] as const;

/**
 * rowSteps gives how Down and Up step the cursor through `count` rows, from
 * the first or the last where none has it, for a kind's targets.
 */
export function rowSteps(count: number): Required<Pick<Targets, "step" | "keys">> {
  const step = (key: string, at: number | undefined): number | undefined => {
    const to =
      key === ROWS_STEP[0] ? (at ?? -1) + 1 : key === ROWS_STEP[1] ? (at ?? count) - 1 : undefined;
    return to === undefined ? undefined : Math.min(Math.max(to, 0), count - 1);
  };
  return { step, keys: ROWS_STEP };
}
