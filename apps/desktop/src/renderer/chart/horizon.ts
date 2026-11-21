/**
 * @fileoverview A horizon chart: a row per series, its amounts cut into equal
 * bands of one round scale for every row, each folded into the row over the
 * last, a darker band a larger amount for every eye; below zero in the pole's
 * steps. A legend over the rows keys the bands.
 */

import type { HeatTally, TimeTally } from "@engine";
import { el } from "@renderer/shell/util";
import { barsBox } from "./bars.ts";
import type { PlotRoom } from "./kind.ts";
import { classesOver, fillOf, scaleOf } from "./ramp.ts";
import { BARS_INSET, row, rowsIn, trackWide } from "./rows.ts";
import { TICK_GAP, mark } from "./scatter.ts";

/** The bands a row folds its amounts into, and the ramp's steps they wear, lightest first: adjacent steps, which theme.test.ts holds apart. */
export const HORIZON_BANDS = 3;
const BAND_STEPS = [2, 3, 4] as const;

/** The most series a horizon chart draws a row for, and the least room a period takes across, in px. */
export const HORIZON_ROWS_AT_MOST = 12;
const PITCH_LEAST = 1;

/** The rows the legend over the bands takes. */
const LEGEND_ROWS = 1;

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

/** bandFill gives the colour band `k` wears, 1 to HORIZON_BANDS above zero and -1 down below it. */
function bandFill(k: number): string | undefined {
  return fillOf(Math.sign(k) * BAND_STEPS[Math.abs(k) - 1]!);
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
  for (const sign of [1, -1]) {
    for (const k of BAND_STEPS.keys()) {
      const path = mark("path", "chart-horizon-band");
      path.setAttribute(
        "d",
        bandOf(
          amounts.map((a) => sign * a),
          band,
          k,
        ),
      );
      path.style.fill = bandFill(sign * (k + 1)) ?? "";
      drawn.append(path);
    }
  }
  return drawn;
}

/**
 * horizonRows draws `series`, of rows or of sums where `summed`, in a plot
 * `height` px high: the legend of its bands, then a row a series that fits,
 * at most HORIZON_ROWS_AT_MOST, every row on one scale.
 */
export function horizonRows(
  series: readonly Series[],
  summed: boolean,
  room: PlotRoom,
  height: number,
): HTMLElement {
  const box = barsBox("chart-horizon");
  box.style.setProperty("--tick-gap", `${TICK_GAP}px`);
  const fits = Math.max(rowsIn(height) - LEGEND_ROWS, 1);
  const drawn = series.slice(0, Math.min(HORIZON_ROWS_AT_MOST, fits));
  const amounts = drawn.flatMap((s) => s.amounts);
  const bands = classesOver(amounts, !summed, HORIZON_BANDS);
  const names = drawn.flatMap(({ value }) => (value === undefined ? [] : [value]));
  const scale = scaleOf(
    bands,
    amounts.some((a) => a < 0),
    trackWide(names, room),
    room.ch,
    bandFill,
  );
  const legend = el("div", "chart-bar-row chart-heat-legend");
  legend.append(...(names.length > 0 ? [el("span")] : []), scale);
  box.append(legend);
  for (const { value, amounts } of drawn) {
    const bandsRow = el("div", "chart-horizon-row");
    bandsRow.append(strip(amounts, bands.width));
    box.append(value === undefined ? bandsRow : row(value, bandsRow));
  }
  return box;
}
