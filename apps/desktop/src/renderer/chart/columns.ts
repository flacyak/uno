/**
 * @fileoverview An over-time chart's columns: one per period of a level, in
 * time order, each from zero to its rows or its sum, over a gridline at each
 * of the y axis's ticks, whose labels stand left of the plot as a scatter's
 * do. Every period from the level's first to its last has a slot the plot's
 * height, so an empty period is a zero column with room of its own.
 *
 * The columns are HTML that chart.css lays out in shares of the plot, and
 * the gridlines SVG, so a theme recolours them and a zoom keeps them crisp.
 */

import type { TimeLevel } from "@tally";
import { el } from "@renderer/shell/util";
import { axis, gutter, tickLabels } from "./axes.ts";
import type { Axis } from "./axes.ts";
import { lengthsOf } from "./bars.ts";
import type { PlotRoom } from "./kind.ts";
import { BARS_INSET, BAR_GAP, BAR_THICK } from "./rows.ts";
import { TICK_GAP, gridline, mark, percent } from "./scatter.ts";
import { ticksOf } from "./timeAxis.ts";

/** The least room a period takes across, in px: a 2 px column and the dataviz skill's 2 px gap. */
export const COLUMN_PITCH_LEAST = 4;

/** The level a plot draws, and whether each of its periods has COLUMN_PITCH_LEAST px. */
export interface Fitted {
  level: TimeLevel;
  fits: boolean;
}

/** lengths gives how long each period of `level` sent draws, by its sum where `summed`. */
function lengths(level: TimeLevel, summed: boolean): number[] {
  return lengthsOf(summed ? level.sum : level.rows);
}

/** upOf gives the y axis of columns `lengths` long: from zero, or under it, to the longest. */
function upOf(lengths: readonly number[]): Axis {
  return axis(Math.min(0, ...lengths), Math.max(0, ...lengths));
}

/** aside gives the room `up`'s labels and their gap take left of the periods, as chart.css lays them out. */
function aside(up: Axis, room: PlotRoom): number {
  return Math.ceil(gutter(up) * room.ch) + TICK_GAP;
}

/**
 * fitted gives the finest of `levels`, finest first, whose periods each get
 * COLUMN_PITCH_LEAST px of `room` past the y axis's labels, as chart.css lays
 * them out, or the coarsest where none does. It is undefined of no levels.
 */
export function fitted(
  levels: readonly TimeLevel[],
  summed: boolean,
  room: PlotRoom,
): Fitted | undefined {
  const fits = (level: TimeLevel): boolean =>
    level.span * COLUMN_PITCH_LEAST <=
    room.width - 2 * BARS_INSET - aside(upOf(lengths(level, summed)), room);
  const level = levels.find(fits) ?? levels.at(-1);
  return level === undefined ? undefined : { level, fits: fits(level) };
}

/**
 * columns draws `level` as columns of its rows, or of its sums where `summed`,
 * on a y axis from the least of them, or zero, to the most. A period past
 * those sent has its slot, and no column until its batch comes. Where the
 * level does not `fit`, each column takes its whole slot. Its periods are
 * labelled under them, as many as stand apart in `room`.
 */
export function columns({ level, fits }: Fitted, summed: boolean, room: PlotRoom): HTMLElement {
  const box = el("div", "chart-time");
  const sent = lengths(level, summed);
  const up = upOf(sent);
  const low = up.ticks[0]!;
  const span = up.ticks.at(-1)! - low;
  const share = (value: number): number => (value - low) / span;
  const grid = mark("svg", "chart-gridlines");
  grid.setAttribute("aria-hidden", "true");
  const labels = el("div", "chart-ticks y");
  // SVG counts down from the top, and an axis up from its first tick.
  for (const [i, label] of tickLabels(up).entries()) {
    const at = percent(1 - share(up.ticks[i]!));
    grid.append(gridline("y", "0", at, "100%", at));
    label.style.top = at;
    labels.append(label);
  }
  const periods = el("div", "chart-periods");
  periods.append(grid);
  for (let i = 0; i < level.span; i++) {
    const slot = el("div", "chart-period");
    const length = sent[i];
    if (length !== undefined) {
      slot.classList.toggle("below", length < 0);
      slot.style.setProperty("--share", `${Math.abs(length) / span}`);
      slot.append(el("div", "chart-column"));
    }
    periods.append(slot);
  }
  const along = el("div", "chart-ticks x");
  const across = room.width - 2 * BARS_INSET - aside(up, room);
  for (const { at, words } of ticksOf(level, across, -aside(up, room), room.ch)) {
    const tick = el("span", "chart-tick", words);
    tick.style.setProperty("--at", `${(at + 1 / 2) / level.span}`);
    tick.style.setProperty("--wide", `${words.length}ch`);
    along.append(tick);
  }
  box.classList.toggle("crowded", !fits);
  box.style.setProperty("--zero", `${share(0)}`);
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  box.style.setProperty("--gutter", `${gutter(up)}ch`);
  box.style.setProperty("--tick-gap", `${TICK_GAP}px`);
  box.style.setProperty("--bar-thick", `${BAR_THICK}px`);
  box.style.setProperty("--bar-gap", `${BAR_GAP}px`);
  box.append(labels, periods, along);
  return box;
}
