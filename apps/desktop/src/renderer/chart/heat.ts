/**
 * @fileoverview A heatmap over periods: a row per value, largest first, and a
 * cell per period at the finest size whose cells fit, each in the class of its
 * rows or its sum, the accent's above zero and the pole's below, and a period
 * of no rows in the rule. The cells are HTML in shares of the plot.
 */

import type { HeatTally } from "@engine";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import type { SplitLevel } from "@tally";
import { barsBox } from "./bars.ts";
import type { PlotRoom } from "./kind.ts";
import { fullName } from "./periods.ts";
import { classOf, classesOver, fillOf, scaleOf } from "./ramp.ts";
import { BARS_INSET, row, rowsIn } from "./rows.ts";
import { TICK_GAP } from "./scatter.ts";
import { ticksOf } from "./timeAxis.ts";
import { among, named } from "./tooltip.ts";
import type { Reading, Targets } from "./tooltip.ts";
import { stepsOf } from "./week.ts";

/** The most values a heatmap draws a row for, before a line counts the rest. */
export const HEAT_ROWS_AT_MOST = 12;

/** The least room a period takes across, in px: a 4 px cell and the dataviz skill's 2 px gap. */
export const HEAT_PITCH_LEAST = 6;

/** The share of the plot the values' names take at most, and the gap after them, as bars' are. */
const NAMES_MOST = 0.4;
const NAMES_GAP = 8;

/** The rows the legend over the cells and the periods' labels under them take. */
const ROWS_BESIDE = 2;

/** cellsWide gives how wide the cells of `tally` stand in `room`, after its values' names. */
function cellsWide(tally: HeatTally, room: PlotRoom): number {
  const inside = room.width - 2 * BARS_INSET;
  const longest = Math.max(0, ...tally.values.map(({ value }) => value.length));
  return inside - Math.min(longest * room.ch, NAMES_MOST * inside) - NAMES_GAP;
}

/** heatLevel gives the finest size of `tally` whose periods each get HEAT_PITCH_LEAST px of `room`, or the coarsest. */
export function heatLevel(tally: HeatTally, room: PlotRoom): SplitLevel | undefined {
  const wide = cellsWide(tally, room);
  return tally.levels.find((l) => l.span * HEAT_PITCH_LEAST <= wide) ?? tally.levels.at(-1);
}

/**
 * heatGrid draws `level` of `tally` in a plot `height` px high: the legend,
 * then a row per value that fits, at most HEAT_ROWS_AT_MOST, each a cell per
 * period in the class of its rows, or of its sum where `summed`, and a line
 * counting the values left out.
 */
export function heatGrid(
  tally: HeatTally,
  level: SplitLevel,
  summed: boolean,
  room: PlotRoom,
  height: number,
): HTMLElement {
  const box = barsBox("chart-heat");
  box.style.setProperty("--tick-gap", `${TICK_GAP}px`);
  const fits = Math.max(rowsIn(height) - ROWS_BESIDE, 1);
  const left = (shown: number) => tally.values.length - shown + tally.others.values;
  let shown = Math.min(tally.values.length, HEAT_ROWS_AT_MOST, fits);
  if (left(shown) > 0 && shown === fits) shown = Math.max(shown - 1, 1);
  const amounts = (summed ? level.sum : level.rows).slice(0, shown);
  const classes = classesOver(amounts.flat(), !summed);
  const signed = amounts.some((each) => each.some((amount) => amount < 0));
  const legend = el("div", "chart-bar-row chart-heat-legend");
  legend.append(el("span"), scaleOf(classes, signed, cellsWide(tally, room), room.ch));
  box.append(legend);
  for (const [i, { value }] of tally.values.slice(0, shown).entries()) {
    const cells = el("div", "chart-heat-cells");
    cells.style.setProperty("--span", `${level.rows[i]!.length}`);
    for (const [p, rows] of level.rows[i]!.entries()) {
      const cell = el("span", "chart-heat-cell");
      const fill = rows > 0 ? fillOf(classOf(amounts[i]![p]!, classes)) : undefined;
      if (fill !== undefined) cell.style.setProperty("--fill", fill);
      cells.append(cell);
    }
    box.append(row(value, cells));
  }
  const rest = tally.values.slice(shown).reduce((n, v) => n + v.rows, tally.others.rows);
  if (left(shown) > 0) {
    const more = m.chart_bars_more({ count: num(left(shown)) });
    box.append(el("div", "chart-bars-line", `${more} · ${m.rows_count({ count: rest })}`));
  }
  box.append(periodsUnder(level, cellsWide(tally, room), room.ch));
  return box;
}

/** periodsUnder gives the row of `level`'s periods' labels under cells `wide` px across, as an over-time chart's. */
function periodsUnder(level: SplitLevel, wide: number, ch: number): HTMLElement {
  const { per, from, span } = level;
  const along = el("div", "chart-ticks x");
  for (const { at, words } of ticksOf(
    { per, from, span, offset: 0, rows: [], sum: [] },
    wide,
    0,
    ch,
  )) {
    const tick = el("span", "chart-tick", words);
    tick.style.setProperty("--at", `${(at + 1 / 2) / span}`);
    tick.style.setProperty("--wide", `${words.length}ch`);
    along.append(tick);
  }
  const under = el("div", "chart-bar-row chart-heat-periods");
  under.append(el("span"), along);
  return under;
}

/**
 * heatTargets gives the cells of `drawn`, as heatGrid drew `level` of
 * `tally`: each worth its rows, or its sum and rows where `summed`, named by
 * its value and its period in full. Right and Left step along a value, Home
 * and End to its ends, and Down and Up to the same period of the next value
 * and the one before.
 */
export function heatTargets(
  tally: HeatTally,
  level: SplitLevel,
  summed: boolean,
  drawn: HTMLElement,
): Targets {
  const cells = [...drawn.querySelectorAll<HTMLElement>(".chart-heat-cell")];
  const all = cells.map((mark, n) => {
    const [i, p] = [Math.floor(n / level.span), n % level.span];
    const said = (): Reading[] => {
      const name = el("span");
      name.append(named(tally.values[i]!.value), `, ${fullName(level.per, level.from + p)}`);
      const rows = { value: num(level.rows[i]![p]!), label: el("span", "", m.chart_table_rows()) };
      return summed
        ? [{ value: num(level.sum[i]![p]!), label: name }, rows]
        : [{ ...rows, label: name }];
    };
    const key = mark.style.getPropertyValue("--fill") || "var(--rule)";
    return { mark, at: mark, front: false, key, said };
  });
  const step = (key: string, at: number | undefined): number | undefined => {
    const to = stepsOf(level.span, cells.length).get(key);
    if (to === undefined) return undefined;
    return at === undefined ? 0 : to(at);
  };
  return { all, under: among(all, ".chart-heat-cell"), step, keys: ["ArrowDown", "ArrowUp"] };
}
