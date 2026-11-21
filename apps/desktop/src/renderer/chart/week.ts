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
import { classOf, classesOver } from "./ramp.ts";
import { BARS_INSET } from "./rows.ts";

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

/** weekGrid draws `tally`'s hours as cells, each in the class of its rows, or of its sum where `summed`. */
export function weekGrid(tally: WeekTally, summed: boolean): HTMLElement {
  const box = el("div", "chart-week");
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  const cells = el("div", "chart-week-cells");
  cells.style.setProperty("--days", `${WEEK_DAYS}`);
  cells.style.setProperty("--hours", `${DAY_HOURS}`);
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
  box.append(cells);
  return box;
}
