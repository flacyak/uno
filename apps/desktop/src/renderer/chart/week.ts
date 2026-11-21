/**
 * @fileoverview A week heatmap: a cell per hour of the week, a row per day
 * from Sunday and a column per hour, each in the class of its rows or its sum.
 * Above zero a cell wears the accent's step of the ramp, below it the pole's,
 * and an hour of no rows, or of a sum of zero, the gridline's rule.
 *
 * The cells are HTML that chart.css lays out in shares of the plot, so a theme
 * recolours them and a zoom keeps them crisp.
 */

import type { WeekTally } from "@engine";
import { el } from "@renderer/shell/util";
import { DAY_HOURS, WEEK_DAYS } from "@tally";
import type { PlotRoom } from "./kind.ts";
import { dayName, hourName } from "./periods.ts";
import { classOf, classesOver } from "./ramp.ts";
import { BARS_INSET } from "./rows.ts";
import { TICK_GAP } from "./scatter.ts";

/** The steps a week heatmap labels its hours at, each a whole share of a day, finest first. */
const HOUR_STEPS = [1, 2, 3, 6, 12] as const;

/** The least room between two hours' labels, in a tick's characters. */
const LABELS_APART = 1;

/** The gap between a week heatmap's cells, in px: the dataviz skill's between fills. */
const CELL_GAP = 2;

/** The ramp a class wears either side of zero: the accent's above, the pole's below. */
const ARMS = { up: "seq", down: "div" } as const;

/** fillOf gives the colour a cell of class `step` wears, none at zero, which wears the rule. */
function fillOf(step: number): string | undefined {
  if (step === 0) return undefined;
  return `var(--${step > 0 ? ARMS.up : ARMS.down}-${Math.abs(step)})`;
}

/** amountsOf gives each hour of `tally`'s rows, or its sum where `summed`, Sunday 00:00 first. */
export function amountsOf(tally: WeekTally, summed: boolean): number[] {
  return tally.hours.map((hour) => (summed ? hour.sum : hour.rows));
}

/**
 * hourStep gives how many hours apart a week heatmap in `room` labels its
 * hours: the fewest whose labels, after a column of day names `daysCh`
 * characters wide, stand LABELS_APART apart, or a label every 12 hours.
 */
export function hourStep(room: PlotRoom, daysCh: number): number {
  const cells = room.width - 2 * BARS_INSET - daysCh * room.ch - TICK_GAP;
  const pitch = (cells + CELL_GAP) / DAY_HOURS;
  const widest = Math.max(...Array.from({ length: DAY_HOURS }, (_, h) => hourName(h).length));
  const wanted = (widest + LABELS_APART) * room.ch;
  return HOUR_STEPS.find((step) => step * pitch >= wanted) ?? HOUR_STEPS.at(-1)!;
}

/** labelled gives a week heatmap's day names in a column, and its hours under its cells every `step`. */
function labelled(step: number): [HTMLElement, HTMLElement] {
  const days = el("div", "chart-week-days");
  for (let d = 0; d < WEEK_DAYS; d++) days.append(el("span", "chart-tick", dayName(d, "short")));
  const hours = el("div", "chart-week-hours");
  for (let h = 0; h < DAY_HOURS; h += step) {
    const label = el("span", "chart-tick", hourName(h));
    label.style.setProperty("--hour", `${h + 1}`);
    hours.append(label);
  }
  return [days, hours];
}

/** weekGrid draws `tally`'s hours as cells, each in the class of its rows, or of its sum where `summed`. */
export function weekGrid(tally: WeekTally, summed: boolean, room: PlotRoom): HTMLElement {
  const box = el("div", "chart-week");
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  box.style.setProperty("--tick-gap", `${TICK_GAP}px`);
  box.style.setProperty("--gap", `${CELL_GAP}px`);
  box.style.setProperty("--days", `${WEEK_DAYS}`);
  box.style.setProperty("--hours", `${DAY_HOURS}`);
  const names = Array.from({ length: WEEK_DAYS }, (_, d) => dayName(d, "short"));
  const [days, hours] = labelled(hourStep(room, Math.max(...names.map((n) => n.length))));
  const cells = el("div", "chart-week-cells");
  const amounts = amountsOf(tally, summed);
  const classes = classesOver(amounts, !summed);
  for (const [i, { rows }] of tally.hours.entries()) {
    const cell = el("span", "chart-week-cell");
    const step = rows > 0 ? classOf(amounts[i]!, classes) : undefined;
    if (step !== undefined) cell.dataset["step"] = `${step}`;
    const fill = step === undefined ? undefined : fillOf(step);
    if (fill !== undefined) cell.style.setProperty("--fill", fill);
    cells.append(cell);
  }
  box.append(days, cells, hours);
  return box;
}
