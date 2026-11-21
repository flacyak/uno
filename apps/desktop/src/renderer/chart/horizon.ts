/**
 * @fileoverview A horizon chart: a row per series, its amounts cut into equal
 * bands of one scale for every row, each folded into the row over the last, a
 * darker band a larger amount for every eye; below zero in the pole's steps.
 */

import type { HeatTally, TimeTally } from "@engine";
import { el } from "@renderer/shell/util";
import { barsBox } from "./bars.ts";
import type { PlotRoom } from "./kind.ts";
import { BARS_INSET, row, rowsIn } from "./rows.ts";
import { mark } from "./scatter.ts";

/** The bands a row folds its amounts into, and the ramp's steps they wear, lightest first: adjacent steps, which theme.test.ts holds apart. */
export const HORIZON_BANDS = 3;
const BAND_STEPS = [2, 3, 4] as const;

/** The most series a horizon chart draws a row for, and the least room a period takes across, in px. */
export const HORIZON_ROWS_AT_MOST = 12;
const PITCH_LEAST = 1;

/** A series a horizon chart draws: its value, none for a chart of one, and its amount per period. */
export interface Series {
  value: string | undefined;
  amounts: readonly number[];
}

/** seriesOf gives `tally`'s series, of rows or sums, at its finest size whose periods get a px of `room`. */
export function seriesOf(tally: TimeTally | HeatTally, summed: boolean, room: PlotRoom): Series[] {
  const fits = (span: number) => span * PITCH_LEAST <= room.width - 2 * BARS_INSET;
  if (tally.t === "time") {
    const level = tally.levels.find((l) => fits(l.span)) ?? tally.levels.at(-1);
    return level ? [{ value: undefined, amounts: summed ? level.sum : level.rows }] : [];
  }
  const level = tally.levels.find((l) => fits(l.span)) ?? tally.levels.at(-1);
  const amounts = level === undefined ? [] : summed ? level.sum : level.rows;
  return amounts.map((each, i) => ({ value: tally.values[i]!.value, amounts: each }));
}

/** bandOf gives the path of band `k` of `amounts` folded into a row 1 high, each amount `band` a band, from zero up. */
function bandOf(amounts: readonly number[], band: number, k: number): string {
  const heights = amounts.map((a) => Math.min(Math.max((a - k * band) / band, 0), 1));
  return `M0 1${heights.map((h, i) => `V${1 - h}H${i + 1}`).join("")}V1Z`;
}

/** strip draws `amounts` in a row as folded bands, each `band` an amount, above zero and below. */
function strip(amounts: readonly number[], band: number): SVGSVGElement {
  const drawn = mark("svg", "chart-horizon-bands");
  drawn.setAttribute("viewBox", `0 0 ${amounts.length} 1`);
  drawn.setAttribute("preserveAspectRatio", "none");
  for (const [arm, sign] of [
    ["seq", 1],
    ["div", -1],
  ] as const) {
    for (const [k, step] of BAND_STEPS.entries()) {
      const path = mark("path", "chart-horizon-band");
      path.setAttribute(
        "d",
        bandOf(
          amounts.map((a) => sign * a),
          band,
          k,
        ),
      );
      path.style.fill = `var(--${arm}-${step})`;
      drawn.append(path);
    }
  }
  return drawn;
}

/** horizonRows draws `series` in a plot `height` px high: a row each that fits, at most HORIZON_ROWS_AT_MOST, on one scale. */
export function horizonRows(series: readonly Series[], height: number): HTMLElement {
  const box = barsBox("chart-horizon");
  const shown = series.slice(0, Math.min(HORIZON_ROWS_AT_MOST, Math.max(rowsIn(height), 1)));
  const most = Math.max(0, ...shown.flatMap((s) => s.amounts.map(Math.abs)));
  const band = most === 0 ? 1 : most / HORIZON_BANDS;
  for (const { value, amounts } of shown) {
    const bands = el("div", "chart-horizon-row");
    bands.append(strip(amounts, band));
    box.append(value === undefined ? bands : row(value, bands));
  }
  return box;
}
