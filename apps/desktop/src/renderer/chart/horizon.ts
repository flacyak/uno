/**
 * @fileoverview A horizon chart: a row per series, its amounts cut into equal
 * bands of one round scale for every row, each folded into the row over the
 * last, a darker band a larger amount for every eye; below zero in the pole's
 * steps. A legend over the rows keys the bands, and under them a line counts
 * the values left out, over their periods' labels.
 */

import type { HeatTally, TimeTally } from "@engine";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { barsBox } from "./bars.ts";
import { periodsUnder } from "./heat.ts";
import type { Periods } from "./heat.ts";
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

/** The rows the legend over the bands and the periods' labels under them take. */
const ROWS_BESIDE = 2;

/** A series a horizon chart draws: its value, none for a chart of one, its rows, and its amount per period. */
export interface Series {
  value: string | undefined;
  rows: number;
  amounts: readonly number[];
}

/** What a horizon chart draws: its periods, its series, largest first, and the values its tally did not send. */
export interface Horizon {
  periods: Periods;
  series: Series[];
  others: { values: number; rows: number };
}

/** seriesOf gives `tally`'s series, of rows or sums, at its finest size whose periods get a px of `room`, none of no periods. */
export function seriesOf(
  tally: TimeTally | HeatTally,
  summed: boolean,
  room: PlotRoom,
): Horizon | undefined {
  const fits = (span: number) => span * PITCH_LEAST <= room.width - 2 * BARS_INSET;
  if (tally.t === "time") {
    const level = tally.levels.find((l) => fits(l.span)) ?? tally.levels.at(-1);
    const rows = level?.rows.reduce((all, each) => all + each, 0) ?? 0;
    if (level === undefined) return undefined;
    const series = [{ value: undefined, rows, amounts: summed ? level.sum : level.rows }];
    const periods = { per: level.per, from: level.from + level.offset, span: level.rows.length };
    return { periods, series, others: { values: 0, rows: 0 } };
  }
  const level = tally.levels.find((l) => fits(l.span)) ?? tally.levels.at(-1);
  if (level === undefined) return undefined;
  const series = (summed ? level.sum : level.rows).map((each, i) => {
    const { value, rows } = tally.values[i]!;
    return { value, rows, amounts: each };
  });
  return { periods: level, series, others: tally.others };
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
 * horizonRows draws `horizon`, of rows or of sums where `summed`, in a plot
 * `height` px high: the legend of its bands, then a row a series that fits,
 * at most HORIZON_ROWS_AT_MOST, every row on one scale, and a line counting
 * the values left out.
 */
export function horizonRows(
  { periods, series, others }: Horizon,
  summed: boolean,
  room: PlotRoom,
  height: number,
): HTMLElement {
  const alone = series[0]?.value === undefined;
  const box = barsBox("chart-horizon", ...(alone ? ["alone"] : []));
  box.style.setProperty("--tick-gap", `${TICK_GAP}px`);
  const fits = Math.max(rowsIn(height) - ROWS_BESIDE, 1);
  const left = (shown: number) => series.length - shown + others.values;
  let shown = Math.min(series.length, HORIZON_ROWS_AT_MOST, fits);
  if (left(shown) > 0 && shown === fits) shown = Math.max(shown - 1, 1);
  const drawn = series.slice(0, shown);
  const amounts = drawn.flatMap((s) => s.amounts);
  const bands = classesOver(amounts, !summed, HORIZON_BANDS);
  const names = drawn.flatMap(({ value }) => (value === undefined ? [] : [value]));
  const wide = trackWide(names, room);
  const scale = scaleOf(
    bands,
    amounts.some((a) => a < 0),
    wide,
    room.ch,
    bandFill,
  );
  const legend = el("div", "chart-bar-row chart-heat-legend");
  legend.append(el("span"), scale);
  box.append(legend);
  for (const { value, amounts } of drawn) {
    const bandsRow = el("div", "chart-horizon-row");
    bandsRow.append(strip(amounts, bands.width));
    box.append(value === undefined ? bandsRow : row(value, bandsRow));
  }
  if (left(shown) > 0) {
    const rest = series.slice(shown).reduce((n, s) => n + s.rows, others.rows);
    const more = m.chart_bars_more({ count: num(left(shown)) });
    box.append(el("div", "chart-bars-line", `${more} · ${m.rows_count({ count: rest })}`));
  }
  box.append(periodsUnder(periods, wide, room.ch));
  return box;
}
